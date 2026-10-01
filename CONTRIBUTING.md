# Contributing to KubeStacks

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/kotapeter/kubestacks/issues) first
  for anything bigger than a small fix, so we can agree on the approach.
- **Scope:** KubeStacks is for looking after workloads, clusters and Helm releases. Managing
  kubeconfig files (adding contexts, signing in to cloud providers) is out of scope.
- **Security issues:** please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setting up

```sh
nvm use          # Node.js 26 (24 also works)
npm ci
npm run dev:mock # runs the app against the built-in demo clusters
```

`npm run dev` uses your own kubeconfig instead. The app can change clusters, so try your
work against the demo clusters or a local [kind](https://kind.sigs.k8s.io) cluster, not
production. `KUBESTACKS_READ_ONLY=1 npm run dev` keeps every cluster read-only.

## Making a change

1. Create a branch from `main`.
2. Keep the change focused, and match the style of the code around it.
3. Add or update end-to-end tests in `tests/e2e/` for what you changed. Tests drive the real
   app through the UI, like a user would. If you need a new cluster state, add it to the demo
   fixture in `tests/mock-cluster/fixtures/` (when it's realistic) or create it in the test
   with `clusters.demo.upsert(...)`.
4. Run the checks:

   ```sh
   npm run verify   # format check, lint, typecheck, e2e tests with coverage report
   ```

   With Docker, `npm run test:linux` also runs the e2e tests on Linux, as CI does.

5. Open a pull request describing what changed and why. Screenshots help for UI changes
   (`npm run build && node scripts/screenshots.ts` captures the standard set).

Changes to how KubeStacks talks to clusters are also worth checking against a real one:
`npm run test:kind` creates a local [kind](https://kind.sigs.k8s.io) cluster and runs the
integration tests (see the README).

## Coverage

The project keeps **100% end-to-end coverage** of statements, branches, functions and lines,
enforced in CI. `npm run coverage` prints the report and writes an HTML version to
`coverage/index.html`, and `npm run coverage:check` lists every uncovered line.

A few code paths only run on one operating system, for example native title-bar colors on
Windows and Linux. CI merges coverage from Linux, macOS and Windows, so those show as
uncovered when you run locally.

When a line is hard to reach, first ask whether it's needed. Fallbacks for fields the
Kubernetes API always fills in can usually go. Otherwise add the realistic state to the demo
cluster and a test that shows it.

## Code style

- TypeScript everywhere, `strict` mode. Prettier and ESLint are enforced in CI
  (`npm run format` fixes formatting).
- UI: Tailwind CSS with the design tokens in `src/renderer/src/styles/index.css`. Use the
  status colors only for health, and always pair them with an icon and a label.
- Main process: everything that crosses IPC is untrusted input and must be validated.

## Releasing (maintainers)

Releases are automatic: a version is released once it reaches `main` and CI passes. Versions
follow [semantic versioning](https://semver.org): a fix is a patch release (1.2.1), anything
new a minor one (1.3.0), and a change that breaks how people use the app (dropping a
platform or a Kubernetes version, removing a feature) a major one (2.0.0). A version with a
suffix, like `1.3.0-beta.1`, is published as a pre-release.

1. Set the version: `npm version 1.2.0 --no-git-tag-version`.
2. In `CHANGELOG.md`, move what's under _Unreleased_ into a `## [1.2.0] - <date>` section,
   and update the links at the bottom.
3. Commit and push to `main`.

When CI passes on that commit, the _Release_ workflow sees a version without a release, and
builds the installers for every platform (signing and notarizing the macOS app). It attaches
them and a `SHA256SUMS.txt` to a GitHub release, with the version's CHANGELOG section as
its notes, and publishes it with an annotated tag, `v1.2.0`, on the commit CI tested. It
refuses a version that isn't newer than the last release, or that has no CHANGELOG section.
Each file gets a signed build provenance attestation (`gh attestation verify <file> --repo
kotapeter/kubestacks`), and published releases are immutable. A release that fails part of
the way can be run again from the workflow's page (_Run workflow_).

The signing secrets are in the repository's `release` environment, which only `main` can
use:

- macOS: `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (a Developer ID Application certificate,
  exported as a base64-encoded `.p12`), plus an App Store Connect API key to notarize:
  `APPLE_API_KEY_P8` (the `.p8` file's contents), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.
