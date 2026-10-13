# Contributing to Lumovi

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/Lumovi/Lumovi/issues) first
  for anything bigger than a small fix, so we can agree on the approach.
- **Scope:** Lumovi is for looking after workloads, clusters and Helm releases. Managing
  kubeconfig files (adding contexts, signing in to cloud providers) is out of scope.
- **Security issues:** please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Setting up

```sh
nvm use          # Node.js 26 (24 also works)
npm ci
npm run dev:mock # runs the app against the built-in demo clusters
```

`npm run dev` uses your own kubeconfig instead, and `npm run dev:server` serves Lumovi
as it runs in a cluster, against the demo clusters (`npm run dev:server -- --fleet`: as a
fleet of them). The app can change clusters, so try your
work against the demo clusters or a local [kind](https://kind.sigs.k8s.io) cluster, not
production. `LUMOVI_READ_ONLY=1 npm run dev` keeps every cluster read-only.

## Making a change

1. Create a branch from `main`.
2. Keep the change focused, and match the style of the code around it.
3. Add or update end-to-end tests in `tests/e2e/` for what you changed (and in `tests/web/`
   for what's different when Lumovi is served). Tests drive the real app through the UI,
   like a user would. If you need a new cluster state, add it to the demo
   fixture in `tests/mock-cluster/fixtures/` (when it's realistic) or create it in the test
   with `clusters.demo.upsert(...)`.
4. Run the checks:

   ```sh
   npm run verify   # format check, lint, typecheck, e2e tests with coverage report
   ```

   With Docker, `npm run test:linux` also runs the e2e tests on Linux, as CI does.

5. If it changes what people get (`src/`, `charts/`, `packaging/`, `build/`), say so for the
   changelog: add a file to [`changelog.d/`](changelog.d/README.md), named
   `<what>.<section>.md` (`create-alias.fixed.md`), holding the entry as `CHANGELOG.md` will
   have it. Nothing to tell anyone? Put a line in the pull request's text instead:
   `Changelog: none: <why>`. `CHANGELOG.md` itself is written at a release, not before.
6. Open a pull request describing what changed and why. Screenshots help for UI changes
   (`npm run screenshots -- overview pods` takes those two, light and dark, into
   `docs/screenshots`; see [Screenshots](#screenshots)).
   It can merge once CI's _CI passed_ check is green: `main` requires it, of everyone, with no
   one able to bypass it.

On a pull request CI runs every test on Linux and Windows, and on macOS a short set
(`tests/e2e/smoke.txt`), whatever the change touches: GitHub gives an account five macOS machines
at a time, and a full run takes all five. So for now, macOS's full suite runs nightly on
`main`, on a release's pull request, on a run by hand, and where the label `macos-full` asks for
it. `main` runs every test on Linux and Windows after each merge, and macOS's short set. Main's
merges and its nightly run are the ones that count: while either is red, _CI passed_ says so on
every pull request as a warning, with main's commit and the jobs that failed. A pull request
fails only for its own jobs.

Changes to how Lumovi talks to clusters are also worth checking against a real one:
`npm run test:kind` creates a local [kind](https://kind.sigs.k8s.io) cluster and runs the
integration tests (see [docs/development.md](docs/development.md#integration-tests)).

## Adding a tool

Lumovi shows what popular operators run through _plugins_, written as data (the format:
[docs.lumovi.dev/reference/plugin-format](https://docs.lumovi.dev/reference/plugin-format)).
A plugin gives a tool its entry in the sidebar and lists its kinds, and its views say how each
kind is shown: its columns, status, details, related objects, links and actions. Adding a tool
needs no code, and is a good first contribution. To ask for one instead, open a
[_Support a tool_](https://github.com/Lumovi/Lumovi/issues/new?template=tool_request.yml)
issue.

The plugins Lumovi comes with live in their own repository,
[Lumovi-plugins](https://github.com/Lumovi/Lumovi-plugins): a tool is added there, checked by
Lumovi’s own checker against its operator’s pinned CRDs, and released as one signed bundle. Its
README says how. Lumovi’s build takes the release that `plugins.lock.json` names (its version,
the commit its tag points at, and the SHA-256 of its bundle and its index), and checks all of it
again before any plugin is built in (`scripts/plugins-bundle.ts`). Moving Lumovi to a newer
release is a change to that file and nothing else, and the release notes of the Lumovi release
that carries it name the plugins’ release and its digest.

To try a plugin while you write it, put its file in `~/.lumovi/plugins` (or the folder
`LUMOVI_PLUGINS_DIR` names), and run `npm run dev` against a cluster with the tool installed.
Lumovi reads it as one of yours, held to the same checks, and the Plugins page shows what’s wrong
with it, if anything. A plugin of yours carries no code, and replaces one of Lumovi’s only under
that plugin’s name, whole. Plugins are read again on refresh (⌘R / Ctrl+R).

## Coverage

The project keeps **above 95% end-to-end coverage** of statements, branches, functions and
lines, and every source file loaded by some test, enforced in CI. `npm run coverage` prints the
report and writes an HTML version to `coverage/index.html`, and `npm run coverage:check` lists
every uncovered line. New code should come with tests that run it.

A few code paths only run on one operating system, for example native title-bar colors on
Windows and Linux. CI merges coverage from Linux, macOS and Windows, so those show as
uncovered when you run locally. Where a pull request ran only the short set on macOS, what
macOS alone reaches is taken from main's newest green run, for the files the pull request
doesn't change: its figure is an estimate, and main's own, after the merge, is the measure.

When a line is hard to reach, first ask whether it's needed. Fallbacks for fields the
Kubernetes API always fills in can usually go. Otherwise add the realistic state to the demo
cluster and a test that shows it.

## Code style

- TypeScript everywhere, `strict` mode. Prettier and ESLint are enforced in CI
  (`npm run format` fixes formatting).
- UI: Tailwind CSS with the design tokens in `src/renderer/src/styles/index.css`. The app
  is neutral gray; the accent (blue) is only for what you can act on: links, buttons, focus
  and selection. Use the status colors only for health, and always pair them with an icon
  and a label; charts use the `--series-*` colors.
- Main process and server: everything that crosses IPC, or the network, is untrusted input
  and must be validated.

## Screenshots

`docs/screenshots` holds a screenshot of every screen worth showing, light and dark, for the
README, the docs and the website, which link to them by name (see its
[README](docs/screenshots/README.md)). `npm run screenshots` takes them all again from the mock
clusters, and rewrites only those whose pixels changed: the clock is stopped, animations are off,
and addresses are fixed, so an unchanged screen comes out the same. A screen that came out
differently is taken again, up to three times, before it counts as changed.

Take them again after changing how a screen looks, and after a release (they show the version):
Actions → **Screenshots** → _Run workflow_ takes them on macOS and proposes the ones that
changed in a pull request. Taking them on another kind of machine changes every one, as text is
drawn a little differently. To add a screen, describe it in `scripts/screenshots/screens.ts`:
its name (keep it once published), what it shows, where it starts, and what to do there.

The mock clusters answer on ports 46443 to 46446, the addresses the screenshots show, and a
second run at the same time can't have them: it stops at once and says which run has them. To
run them beside another (to check something while screenshots are taken, say), give the first of
four other ports, `LUMOVI_MOCK_CLUSTER_PORTS=47443`, or `free` for any, and the addresses on
screen differ; none takes ports another run has. A run stops when whatever started it does;
`npm run screenshots:stop -- <pid>` stops one left behind (the clash says which pid has the
ports), and with no pid, every one (each leaves a note of itself, in a folder of your own in the
system's temporary folder, while it runs).

## Releasing (maintainers)

Releases are automatic: a version is released once it reaches `main` and CI passes. Versions
follow [semantic versioning](https://semver.org): a fix is a patch release (1.0.1), anything
new a minor one (1.1.0), and a change that breaks how people use the app (dropping a
platform or a Kubernetes version, removing a feature) a major one (2.0.0). A version with a
suffix, like `1.1.0-beta.1`, is published as a pre-release.

1. Set the version: `npm version 1.1.0 --no-git-tag-version`. That sets the Helm chart's too,
   and gathers the changelog: the entries waiting in `changelog.d/` become a
   `## [1.1.0] - <date>` section of `CHANGELOG.md`, under Added, Changed and Fixed in the order
   their pull requests reached `main`, with the version's link at the bottom, and their files
   are deleted.
2. In `CHANGELOG.md`, write the section's opening paragraph by hand, above its entries: what
   the release is, in a sentence or two.
3. Commit, on a branch named `release-1.1.0`, and open a pull request for it.
4. Once CI is green on it, fast-forward `main` to that very commit, without merging:
   `git push origin <commit>:main`. `main` takes a commit pushed this way only once its checks
   have passed, and a merge would make another commit, not the one CI tested.

When CI passes on that commit on `main`, the _Release_ workflow sees a version without a
release, set by that very commit, and waits. A release made by Lumovi's workflow is signed and
published only once it's approved: the environment `release`, where the signing secrets live,
has two required reviewers, the maintainer's own account and the project's, and whoever started
a run can't approve it. So every release takes both: one starts it (by the commit that reaches
`main`, or by hand), and the other approves it. Each job of the run first checks that one of the
two started it, and that no one else ran it again since; a run a bot started (the workflow's own
token among them), or one the other account ran again, is refused before anything is built. A
run that isn't approved has made nothing, and holds nothing up. A later commit that finds the version
still unreleased starts no release by itself; to release `main` as it is then, run the workflow
by hand.

Approved, it builds the installers for every platform (signing and notarizing the macOS app, signing the
Windows one), and the image (`ghcr.io/lumovi/lumovi`) and Helm chart
(`oci://ghcr.io/lumovi/charts`), which it pushes to GitHub's container registry with provenance attestations and signs
with cosign (keyless). It attaches the installers, a `SHA256SUMS.txt` and a bill of
materials (`Lumovi-<version>.cdx.json`) to a GitHub release, with the version's CHANGELOG
section as
its notes, and publishes it with an annotated tag, `v1.1.0`, on the commit CI tested. It
refuses a version that isn't newer than the last release, that has no CHANGELOG section, or
whose entries still wait in `changelog.d/`.
Each file gets a signed build provenance attestation (`gh attestation verify <file> --repo
Lumovi/Lumovi`), the installers one of their bill of materials too (see
[Checking a release](SECURITY.md#checking-a-release)), and published releases are immutable. A release that fails part of
the way can be run again from the workflow's page (_Run workflow_).

The signing secrets are in the repository's `release` environment, which only `main` can
use:

- macOS: `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (a Developer ID Application certificate,
  exported as a base64-encoded `.p12`), plus an App Store Connect API key to notarize:
  `APPLE_API_KEY_P8` (the `.p8` file's contents), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
- Windows: `WIN_SIMPLYSIGN_ID` and `WIN_SIMPLYSIGN_OTP_URI`, the email and the QR code's
  `otpauth://` link of the Certum SimplySign account whose cloud holds the code signing
  certificate's key. The release logs in with them (`scripts/simplysign.ts` makes the codes
  the SimplySign app shows), and signs with the certificate `release.yml`'s
  `WIN_CERTIFICATE_SHA1` names. A renewed certificate's thumbprint goes there; its name,
  `electron-builder.yml`'s `publisherName`, mustn't change: installed versions take only
  updates signed by it.
