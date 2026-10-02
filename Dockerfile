# KubeStacks, served from a cluster: Node.js, helm, the server and the page (docs/server.md).
#
#   docker build -t kubestacks .
#
# The image runs as a non-root user, with nothing but Node.js (no shell), and writes only
# to /tmp. Its Helm chart is in charts/kubestacks.

# The build makes JavaScript, the same for every platform: it runs on the builder's.
FROM --platform=$BUILDPLATFORM node:26-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
# Electron's download (for the desktop app) isn't needed to build the server.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

# helm, for the target platform, checked against its published checksum.
FROM --platform=$BUILDPLATFORM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8 AS helm
ARG TARGETOS
ARG TARGETARCH
ARG HELM_VERSION=4.3.0
RUN apk add --no-cache curl \
 && file="helm-v${HELM_VERSION}-${TARGETOS}-${TARGETARCH}.tar.gz" \
 && curl -fsSLO "https://get.helm.sh/${file}" \
 && echo "$(curl -fsSL "https://get.helm.sh/${file}.sha256sum" | cut -d' ' -f1)  ${file}" | sha256sum -c - \
 && tar -xzf "${file}" --strip-components=1 "${TARGETOS}-${TARGETARCH}/helm" "${TARGETOS}-${TARGETARCH}/LICENSE" \
 && mv LICENSE HELM_LICENSE

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:2ee7b2c54a3e37dfc248af81c9f6bcdcaa50abe4af44aa47a3388431031b9283
ARG VERSION=dev
LABEL org.opencontainers.image.title="KubeStacks" \
      org.opencontainers.image.description="A beautiful, fast Kubernetes dashboard, served from your cluster." \
      org.opencontainers.image.source="https://github.com/KubeStacks/KubeStacks" \
      org.opencontainers.image.url="https://kubestacks.com" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
COPY --from=helm /helm /usr/local/bin/helm
COPY --from=helm /HELM_LICENSE /app/licenses/helm/LICENSE
COPY LICENSE /app/LICENSE
COPY --from=build /src/out/THIRD_PARTY_NOTICES.txt /app/licenses/THIRD_PARTY_NOTICES.txt
COPY --from=build /src/out/server/THIRD_PARTY_NOTICES.txt /app/licenses/SERVER_THIRD_PARTY_NOTICES.txt
COPY --from=build /src/out/server/index.js /app/out/server/index.js
COPY --from=build /src/out/renderer /app/out/renderer
ENV NODE_ENV=production \
    KUBESTACKS_HELM=/usr/local/bin/helm \
    HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data
EXPOSE 8080
USER nonroot
CMD ["/app/out/server/index.js"]
