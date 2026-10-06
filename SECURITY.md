# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, by email to
[security@lumovi.dev](mailto:security@lumovi.dev) or through
[GitHub security advisories](https://github.com/Lumovi/Lumovi/security/advisories/new). Please
don't open a public issue.

Include what you found, how to reproduce it and the impact you expect. What happens next:

- **Within 3 working days:** we acknowledge your report.
- **Within 10 working days:** we tell you whether we can reproduce it, and how serious we
  think it is.
- **Within 90 days of your report:** a release with the fix, and a security advisory
  (with a CVE, where it warrants one) that credits you, unless you'd rather it didn't. We
  agree the date with you, sooner for what's being exploited, and keep you posted until then.

Please give us that time before you publish. We won't take action against research done in
good faith: research that keeps to your own clusters and data, and doesn't disrupt others.

## Supported versions

Security fixes go into a new release of the latest version (1.6.3 after 1.6.2, say). Use
the latest release: the desktop app updates itself, and in a cluster the chart's version
names the image's.

## Security model

### The desktop app

Lumovi handles cluster credentials, so it's built to keep them contained:

- Kubeconfig credentials, including tokens, client keys and credential-plugin output, stay in
  the main process. The page never sees them.
- The page runs sandboxed, with context isolation, no Node.js integration and a strict Content
  Security Policy. It can't navigate away or open new windows.
- The main process only answers IPC calls from the app's own page, and validates every
  argument.
- Changes to clusters go through a small set of validated operations, refused for contexts
  the user made read-only (or all of them, with `LUMOVI_READ_ONLY`, or as an organization's
  policy says).
- Only `https://` links, and `http://localhost:<port>` for your own port forwards, are handed
  to the operating system.
- Updates come from this repository's GitHub releases over HTTPS. Each download is checked
  against the SHA-512 checksum the release lists, and on macOS the new version must carry
  the same Developer ID signature.
- AI assistants connect only if you turn them on, only from this computer, with a token of
  their own, and every change they propose waits for your approval.

Companies rolling Lumovi out can lock what's set on every computer with a
[policy](https://docs.lumovi.dev/desktop/policy) only an administrator can write: read-only
clusters, AI assistants off or limited, updates left to IT, and the proxy and certificate
authorities to use. It sets what Lumovi does; it isn't a wall against the person using the
computer, whose kubeconfig credentials work with kubectl too. What they may do in a cluster
is Kubernetes RBAC's to say.

### In your cluster

- Everyone signs in (single sign-on, a token, or an authenticating proxy in front) and works
  with their own Kubernetes permissions: with their own token, or as the server impersonating
  them, never as Kubernetes' own `system:` users and groups.
- The browser keeps only a session cookie (`HttpOnly`, `SameSite=Lax`, `Secure` behind
  HTTPS). Credentials stay on the server.
- What's done through Lumovi is audited, and can be sent to a webhook or a SIEM as it happens.
- The chart runs it as a non-root user, with a read-only root filesystem, no capabilities and
  the runtime's default seccomp profile, and it works under OpenShift's `restricted-v2`. A
  NetworkPolicy can let only your proxy reach it.

The [hardening guide](https://docs.lumovi.dev/server/hardening) goes through what to set for
a production installation, and [Security](https://docs.lumovi.dev/server/security) through
how the server works.

## Checking a release

Every installer, the image and the chart is built by this repository's
[release workflow](.github/workflows/release.yml), from the release's commit, which signs a
record of that. With the [GitHub CLI](https://cli.github.com) and
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/):

```sh
# Built by the release workflow, from main.
signer=(--repo Lumovi/Lumovi --signer-workflow Lumovi/Lumovi/.github/workflows/release.yml
  --source-ref refs/heads/main)

# An installer: built there, and what it's made of (the release's Lumovi-<version>.cdx.json).
gh attestation verify Lumovi-1.7.0-mac-arm64.dmg "${signer[@]}"
gh attestation verify Lumovi-1.7.0-mac-arm64.dmg "${signer[@]}" \
  --predicate-type https://cyclonedx.org/bom

# The image and the chart: built there, and signed by the release workflow.
gh attestation verify oci://ghcr.io/lumovi/lumovi:1.7.0 "${signer[@]}"
gh attestation verify oci://ghcr.io/lumovi/charts/lumovi:1.7.0 "${signer[@]}"
cosign verify ghcr.io/lumovi/lumovi:1.7.0 \
  --certificate-identity https://github.com/Lumovi/Lumovi/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
cosign verify ghcr.io/lumovi/charts/lumovi:1.7.0 \
  --certificate-identity https://github.com/Lumovi/Lumovi/.github/workflows/release.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# What the image is made of: its JavaScript's packages (CycloneDX, also in the image as
# /app/licenses/sbom.cdx.json), and its system's (SPDX, made as it's built).
gh attestation verify oci://ghcr.io/lumovi/lumovi:1.7.0 "${signer[@]}" \
  --predicate-type https://cyclonedx.org/bom
docker buildx imagetools inspect ghcr.io/lumovi/lumovi:1.7.0 --format '{{ json .SBOM }}'
```

An admission controller ([Kyverno](https://kyverno.io/docs/writing-policies/verify-images/),
[Sigstore's policy controller](https://docs.sigstore.dev/policy-controller/overview/)) can
require the image's signature with the same identity and issuer. The image and the chart are
signed twice, alike: as a Sigstore bundle (an OCI referrer, as cosign 3 signs), and with the
`.sig` tag older controllers look for. Each release also lists its installers' SHA-256
checksums in `SHA256SUMS.txt`.

Releases from 1.7.0 on are signed with cosign and carry a bill of materials; every release
carries the attestations.
