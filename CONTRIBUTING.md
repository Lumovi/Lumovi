# Contributing to KubeStacks

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/KubeStacks/KubeStacks/issues) first
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

`npm run dev` uses your own kubeconfig instead, and `npm run dev:server` serves KubeStacks
as it runs in a cluster, against the demo clusters. The app can change clusters, so try your
work against the demo clusters or a local [kind](https://kind.sigs.k8s.io) cluster, not
production. `KUBESTACKS_READ_ONLY=1 npm run dev` keeps every cluster read-only.

## Making a change

1. Create a branch from `main`.
2. Keep the change focused, and match the style of the code around it.
3. Add or update end-to-end tests in `tests/e2e/` for what you changed (and in `tests/web/`
   for what's different when KubeStacks is served). Tests drive the real app through the UI,
   like a user would. If you need a new cluster state, add it to the demo
   fixture in `tests/mock-cluster/fixtures/` (when it's realistic) or create it in the test
   with `clusters.demo.upsert(...)`.
4. Run the checks:

   ```sh
   npm run verify   # format check, lint, typecheck, e2e tests with coverage report
   ```

   With Docker, `npm run test:linux` also runs the e2e tests on Linux, as CI does.

5. Open a pull request describing what changed and why. Screenshots help for UI changes
   (`npm run screenshots -- overview pods` takes those two, light and dark, into
   `docs/screenshots`; see [Screenshots](#screenshots)).

Changes to how KubeStacks talks to clusters are also worth checking against a real one:
`npm run test:kind` creates a local [kind](https://kind.sigs.k8s.io) cluster and runs the
integration tests (see [docs/development.md](docs/development.md#integration-tests)).

## Adding a tool

KubeStacks shows what popular operators run through _views_ and _add-ons_, written as data
in `src/renderer/src/views/<tool>.yaml` (the format:
[docs.kubestacks.com/reference/view-format](https://docs.kubestacks.com/reference/view-format)).
An add-on gives a tool its entry in the sidebar and lists its kinds; views say how each kind
is shown: its columns, status, details, related objects, links and actions. Adding a tool
needs no code, and is a good first contribution. To ask for one instead, open a
[_Support a tool_](https://github.com/KubeStacks/KubeStacks/issues/new?template=tool_request.yml)
issue.

1. Pin the tool's CRDs: add its release to `tests/views/crds/sources.json`, under the
   add-on's name, with the URLs of its CRD manifests, and run `npm run crds -- <name>`. That
   keeps what the check needs of them in `tests/views/crds/<name>.json`. A chart's templates
   work too (`"helm": true`), and for a tool whose operator creates its CRDs itself, the JSON
   Schema of each kind will do (KubeVirt's come from the
   [CRDs catalog](https://github.com/datreeio/CRDs-catalog)).
2. Write `src/renderer/src/views/<name>.yaml`: the `AddOn`, then a `View` for each kind (or
   group of kinds) worth more than the generic columns. Status rules are where views help
   most: say what healthy, in progress, failing and paused look like for this tool.
3. Run `npm run views:check`. It checks every kind, path, template, link, related list and
   action against the CRDs you pinned, so a misremembered field fails here rather than
   showing nothing. Labels and annotations aren't in schemas, so check those against the
   tool's documentation, or a real cluster.
4. Look at it: put the file in `~/.kubestacks/views` (or the folder `KUBESTACKS_VIEWS_DIR`
   names) while running `npm run dev` against a cluster with the tool installed. Views are
   read again on refresh (⌘R / Ctrl+R).

To check views against a newer release of a tool, change its version in `sources.json`, run
`npm run crds -- <name>` and `npm run views:check`.

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

## Releasing (maintainers)

Releases are automatic: a version is released once it reaches `main` and CI passes. Versions
follow [semantic versioning](https://semver.org): a fix is a patch release (1.2.1), anything
new a minor one (1.3.0), and a change that breaks how people use the app (dropping a
platform or a Kubernetes version, removing a feature) a major one (2.0.0). A version with a
suffix, like `1.3.0-beta.1`, is published as a pre-release.

1. Set the version: `npm version 1.2.0 --no-git-tag-version` (which sets the Helm chart's
   too).
2. In `CHANGELOG.md`, move what's under _Unreleased_ into a `## [1.2.0] - <date>` section,
   and update the links at the bottom.
3. Commit and push to `main`.

When CI passes on that commit, the _Release_ workflow sees a version without a release, and
builds the installers for every platform (signing and notarizing the macOS app), and the
image (`ghcr.io/kubestacks/kubestacks`) and Helm chart (`oci://ghcr.io/kubestacks/charts`),
which it pushes to GitHub's container registry with provenance attestations. It attaches
them and a `SHA256SUMS.txt` to a GitHub release, with the version's CHANGELOG section as
its notes, and publishes it with an annotated tag, `v1.2.0`, on the commit CI tested. It
refuses a version that isn't newer than the last release, or that has no CHANGELOG section.
Each file gets a signed build provenance attestation (`gh attestation verify <file> --repo
KubeStacks/KubeStacks`; `--owner kotapeter` for 1.1.0 and earlier, built before the project
moved), and published releases are immutable. A release that fails part of
the way can be run again from the workflow's page (_Run workflow_).

The signing secrets are in the repository's `release` environment, which only `main` can
use:

- macOS: `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (a Developer ID Application certificate,
  exported as a base64-encoded `.p12`), plus an App Store Connect API key to notarize:
  `APPLE_API_KEY_P8` (the `.p8` file's contents), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
- Windows: `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD`.
