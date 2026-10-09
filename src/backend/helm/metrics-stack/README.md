# The metrics stack's chart

`prometheus-29.36.1.tgz` is prometheus-community's `prometheus` chart, version 29.36.1 (Prometheus
v3.15.0), exactly as its repository publishes it:

- Repository: https://prometheus-community.github.io/helm-charts
- Archive: https://github.com/prometheus-community/helm-charts/releases/download/prometheus-29.36.1/prometheus-29.36.1.tgz
- SHA-256, as the repository's `index.yaml` gives it:
  `8492d3a0e99f99a12bb389f1c83f3636e3fc5d68f995a09e815044773246217e`
- License: Apache-2.0 (https://github.com/prometheus-community/helm-charts/blob/main/LICENSE)

It's built into Lumovi (the desktop app and the server), which checks the SHA-256 before every dry
run and install (`src/shared/metrics-stack.ts` has it), and installs it with `values.yaml`, which
nobody changes from the page.

To move to another version: replace the archive, set its version and SHA-256 in
`src/shared/metrics-stack.ts`, pin the images' digests in `values.yaml` to that version's images
(`docker buildx imagetools inspect <image>:<tag>`), and render it again for the tests:

```sh
helm template lumovi-metrics src/backend/helm/metrics-stack/prometheus-<version>.tgz \
  --namespace lumovi-metrics --values src/backend/helm/metrics-stack/values.yaml
```

into `tests/e2e/helm/metrics-stack.yaml`, under its two comment lines.
