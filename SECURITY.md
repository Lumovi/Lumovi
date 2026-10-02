# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/KubeStacks/KubeStacks/security/advisories/new),
or by email to kotapeter@gmail.com. Please don't open a public issue.

Include what you found, how to reproduce it and the impact you expect. You'll get an
acknowledgement within a few days, and we'll keep you posted as we work on a fix.

## Supported versions

Security fixes go into the latest release.

## Security model

KubeStacks handles cluster credentials, so it's built to keep them contained:

- Kubeconfig credentials, including tokens, client keys and credential-plugin output, stay in
  the main process. The page never sees them.
- The page runs sandboxed, with context isolation, no Node.js integration and a strict Content
  Security Policy. It can't navigate away or open new windows.
- The main process only answers IPC calls from the app's own page, and validates every
  argument.
- Changes to clusters go through a small set of validated operations, refused for contexts
  the user made read-only (or all of them, with `KUBESTACKS_READ_ONLY`).
- Only `https://` links, and `http://localhost:<port>` for your own port forwards, are handed
  to the operating system.
- Updates come from this repository's GitHub releases over HTTPS. Each download is checked
  against the SHA-512 checksum the release lists, and on macOS the new version must carry
  the same Developer ID signature.
