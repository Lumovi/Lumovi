# Development

How KubeStacks is built and tested. To contribute, see [CONTRIBUTING.md](../CONTRIBUTING.md)
too.

- [Getting started](#getting-started)
- [How it's built](#how-its-built)
- [Testing](#testing)
- [Integration tests](#integration-tests)

## Getting started

You need [Node.js](https://nodejs.org) 26 (see `.nvmrc`; 24 also works) and npm.

```sh
npm ci
npm run dev:mock   # the app against a built-in demo cluster, no Kubernetes needed
npm run dev        # the app against your own kubeconfig
npm run dev:server # KubeStacks served, as in a cluster, against the demo cluster
```

| Command                                 |                                                               |
| --------------------------------------- | ------------------------------------------------------------- |
| `npm run dev` / `dev:mock`              | Run with hot reload (real clusters / demo cluster)            |
| `npm run dev:server`                    | Build and serve KubeStacks against the demo cluster           |
| `npm run serve`                         | Run the built server (`out/server`), configured as in docs    |
| `npm run verify`                        | Everything CI checks: format, lint, types, e2e with coverage  |
| `npm run mock-cluster`                  | Start the demo clusters alone and print a kubeconfig for them |
| `npm run test:e2e`                      | Build with coverage instrumentation and run the e2e suite     |
| `npm run test:linux`                    | The same, on Linux in Docker, as CI runs it                   |
| `npm run coverage`                      | The above, plus a coverage report in `coverage/`              |
| `npm run coverage:check`                | Fail unless every file, line, branch and function is covered  |
| `npm run lint` / `typecheck` / `format` | Static checks                                                 |
| `npm run package`                       | Build an unpacked app for this platform in `release/`         |
| `npm run dist`                          | Build installers for this platform                            |
| `npm run screenshots`                   | Take the screenshots in `docs/screenshots` again              |

## How it's built

```
src/
  main/       Electron main process: the window, menus, updates and IPC
  backend/    Kubeconfigs, API requests, Helm, shells and logs: the desktop app's and the server's
  server/     KubeStacks served from a cluster: sign-in, the page, a WebSocket for each page
  preload/    The narrow, typed bridge exposed to the page as window.kubestacks
  renderer/   React UI (Tailwind CSS, TanStack Query, Radix, cmdk), for both
  shared/     Types and the resource registry used by every side
charts/       The Helm chart that runs the server (its image: Dockerfile)
tests/
  e2e/            Playwright tests that drive the real Electron app
  web/            The served app in Chromium, and the server's HTTP and WebSocket
  mock-cluster/   A mock Kubernetes API server with realistic demo clusters
  mock-oidc/      A small OpenID Connect provider, for single sign-on
  integration/    The same app (and the image, with the chart) against a real kind cluster
docs/             Guides (using KubeStacks, in a cluster, views, development), screenshots
scripts/          Coverage tooling, screenshots, icon rendering
```

- **Security.** The page runs sandboxed with context isolation and no Node.js access, under
  a strict Content Security Policy. It can't navigate or open windows. Every IPC call is
  checked for its sender and validated in the main process, which is the only place that
  talks to clusters. Credentials never reach the page.
- **One page, two hosts.** The page talks to its host through one typed API
  (`src/shared/api.ts`): over IPC in the desktop app, over a WebSocket when served. Both
  answer from the same handlers (`src/backend/handlers.ts`); what only one can do (port
  forwards, local charts and updates on the desktop; sessions on the server) is an
  optional part of the API that the page shows only when it's there.
- **Talking to clusters.** Authentication comes from
  [`@kubernetes/client-node`](https://github.com/kubernetes-client/javascript); requests
  are plain REST calls with gzip, so any API path, including metrics and logs, works the
  same way.
- **Design.** Status colors are reserved for health and always come with an icon and a
  label; charts use a colorblind-validated palette in both themes.

## Testing

The e2e suite drives the actual Electron app with Playwright against a mock API server that
serves three demo clusters (a busy one with every kind of problem, an empty one without
metrics, and one with 2,500 pods) plus contexts that fail in every way a real one can:
offline, expired token, untrusted certificate, missing credential plugin, broken
kubeconfig entries and blocked plain HTTP.

The app's windows stay invisible while the tests run, never take focus and stay out of the
Dock, and what the tests copy stays in the app, so you can keep working. Set
`KUBESTACKS_E2E_FOREGROUND=1` to watch them.

`npm run test:linux` runs the suite on Linux in Docker, the way CI does (Xvfb, no mouse), so
Linux-only problems show up before you push. It takes about as long as a local run.

The `web` project starts the server (`out/server`, as its image runs it) against the same
mock clusters and a mock OpenID Connect provider, and drives the page in Chromium: signing
in each way and sessions ending, the WebSocket dropping and coming back, shells, logs and
Helm through the server, and what it answers to anything malformed.

**Coverage is 100% for statements, branches, functions and lines, measured end-to-end.** The
build is instrumented with Istanbul, and coverage is collected from all three Electron
processes (main, preload and renderer), the server, and the page in the browser. A few lines only run on one operating system, such
as native title-bar colors on Windows and Linux, so CI runs the suite on Linux, macOS and
Windows and enforces 100% on the merged result. Locally, `npm run coverage` shows what your
platform reaches.

CI also packages the app on every platform and runs tests against the packaged build.

## Integration tests

The e2e tests above run against mock API servers, so they're fast and can stage any state.
The integration tests check the same app against a real cluster: a three-node
[kind](https://kind.sigs.k8s.io) cluster with metrics-server and kube-prometheus-stack.
They change things for real and check the result with kubectl: scaling, rollouts and
rollbacks, YAML edits and conflicts, creating from YAML, cordoning and draining against a
PodDisruptionBudget, shells, port forwards, debug containers, every usage-history query
against Prometheus, custom resources (a CRD of their own, with validation, status and
scaling, and the Prometheus operator's through KubeStacks' views), Helm releases (read in
both storage drivers, upgraded, rolled back and uninstalled with helm, and a chart installed
from a folder), and what a view-only account is offered. They also install the image with
the Helm chart and sign in to it, behind a proxy and with a token.

You need Docker, [kind](https://kind.sigs.k8s.io), kubectl and Helm.

```sh
npm run kind:up            # create the cluster and install metrics-server and Prometheus (a few minutes)
npm run test:integration   # build, then run the integration tests
npm run kind:down          # delete the cluster
```

The cluster gets its own kubeconfig in `.kind/`. Your `~/.kube/config` isn't read or
changed, and the tests never use any other cluster. The tests can be rerun against the same
cluster: each spec starts from a fresh namespace.
