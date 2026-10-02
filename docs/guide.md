# Using KubeStacks

How to get around KubeStacks, change things safely, and make the most of usage history,
custom resources and Helm. It's the same app on the desktop and in a cluster; where they
differ, it says so. For installing KubeStacks in a cluster and signing in to it, see
[server.md](server.md).

- [Clusters](#clusters)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Finding your way](#finding-your-way)
- [Settings](#settings)
- [Changing things, safely](#changing-things-safely)
- [Usage history](#usage-history)
- [Custom resources](#custom-resources)
- [Helm releases](#helm-releases)

## Clusters

The desktop app reads clusters from the same place `kubectl` does: the files listed in
`KUBECONFIG`, or `~/.kube/config`, with kubectl's merge rules, client certificates,
tokens and exec credential plugins (`gke-gcloud-auth-plugin`, `aws eks get-token`,
`kubelogin`…), including when it's launched from the Dock. Pick a cluster on the start
screen; the status next to each one tells you whether it is reachable and why not (expired
credentials, certificate problems, missing credential plugin…).

In a cluster, KubeStacks shows that one cluster, and everyone sees it with their own
permissions.

## Keyboard shortcuts

| Shortcut (macOS; `Ctrl` elsewhere) |                                                       |
| ---------------------------------- | ----------------------------------------------------- |
| `⌘K`                               | Command palette: views, objects, namespaces, clusters |
| `⌘1` … `⌘6`                        | Overview, Workloads, Pods, Services, Nodes, Events    |
| `G`, then a letter                 | Go to a view (`G W` workloads, `G D` deployments…)    |
| `⌘[` / `⌘]`, `Alt+←` / `Alt+→`     | Back / forward                                        |
| `⌘R`                               | Refresh now                                           |
| `⌘N`                               | Create from YAML                                      |
| `/`                                | Filter the list                                       |
| `↑` `↓` (or `J` `K`), `Home` `End` | Move through the list; `PgUp` `PgDn` jump ten rows    |
| `←` `→`                            | Previous / next page                                  |
| `Enter` / `Esc`                    | Open the focused row / close the detail panel         |
| `X` (`⇧X` for a range), `⌘A`       | Select the focused row / every row on the page        |
| `.`                                | Actions for the open object                           |
| `⌘⌫`                               | Delete the open object                                |
| `⌘S`                               | Review a YAML edit                                    |
| `⌘⇧C`                              | All clusters                                          |
| `?` or `⌘/`                        | All shortcuts, also in the **Help** menu              |

The sidebar shows each view's `G` shortcut when you hover it. In a browser, `⌘N` and
`⌘1` … `⌘6` belong to the browser: the command palette has those commands.

## Finding your way

- **Workloads.** One list of every Deployment, StatefulSet, DaemonSet, Job and CronJob
  (and the Jobs, ReplicaSets and pods nothing manages), with each one's status, ready
  pods, autoscaler range, and CPU and memory added up over its pods, so problems of every
  kind sort to the top together. A tab per kind shows that kind's own list and columns.
  ReplicaSets a Deployment runs and Jobs a CronJob starts are left out; they're on their
  owner's panel, and in ⌘K. **Pods** have a list of their own.
- **Namespaces.** The namespace menu scopes every list. It starts in the namespace set on
  your kubeconfig context, and remembers your choice per cluster. If your account can't
  list namespaces, type one in.
- **Metrics.** Live usage needs [metrics-server](https://github.com/kubernetes-sigs/metrics-server).
  Without it, KubeStacks shows requests and limits against capacity instead.
- **Plain HTTP.** Clusters served over `http://` (for example through `kubectl proxy`) must
  set `insecure-skip-tls-verify: true` in the kubeconfig, the same rule as the official
  JavaScript client.
- **Huge clusters.** Lists are fetched in chunks of 500 and stop at 5,000 objects per list,
  with a note saying so; filter by label to see the rest. Set `KUBESTACKS_MAX_LIST_ITEMS`
  to change the limit.
- **Slow API servers.** Requests time out after 20 seconds. Set
  `KUBESTACKS_REQUEST_TIMEOUT_MS` to change that.

## Settings

The desktop app reads these from the environment when it starts. (In a cluster, KubeStacks
is configured through its Helm chart: see [server.md](server.md#configuration).)

| Variable                        | What it does                                                     |
| ------------------------------- | ---------------------------------------------------------------- |
| `KUBECONFIG`                    | Where clusters come from, as for `kubectl`                       |
| `KUBESTACKS_READ_ONLY=1`        | Makes every cluster read-only, whatever is set in the app        |
| `KUBESTACKS_MAX_LIST_ITEMS`     | The most objects a list loads (5,000)                            |
| `KUBESTACKS_REQUEST_TIMEOUT_MS` | How long the API server has to answer (20,000)                   |
| `KUBESTACKS_VIEWS_DIR`          | Where your own views are (`~/.kubestacks/views`)                 |
| `KUBESTACKS_HELM`               | The `helm` to run (the one on your login shell's `PATH`)         |
| `KUBESTACKS_ARTIFACT_HUB_URL`   | The Artifact Hub to search for charts (`https://artifacthub.io`) |

## Changing things, safely

Open an object and its actions are right there: the common ones as buttons, the rest under
**⋯** (or `.`), in the row's right-click menu and in the command palette.

| Kind                                  | Actions                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| Deployments, StatefulSets, DaemonSets | Scale, restart, change images, roll back to an earlier revision, pause or resume a rollout |
| Pods                                  | Shell, debug container, port forward\*, restart, evict, force-delete stuck pods            |
| Services                              | Port forward\* (to the service's first ready pod)                                          |
| CronJobs and Jobs                     | Run now, suspend, resume                                                                   |
| Nodes                                 | Cordon, uncordon, drain (with live progress per pod)                                       |
| Autoscalers, volume claims            | Change the replica range, expand the volume                                                |
| Everything                            | Edit labels and annotations, edit YAML, delete                                             |
| Selected rows                         | Restart, cordon or uncordon, suspend or resume, delete                                     |

\* In the desktop app.

The guard rails:

- **Your permissions, up front.** KubeStacks asks the cluster what you may do
  (SelfSubjectAccessReviews) and disables what you can't, saying why.
- **Nothing surprising.** Every dialog names the cluster and shows the equivalent `kubectl`
  command. YAML edits are validated by the cluster (a dry run) and shown as a diff before
  they are saved, and a change someone made meanwhile is caught instead of overwritten.
  Secret values are edited as text and saved encoded.
- **Hard to do by accident.** Destructive dialogs start on **Cancel**. Deleting namespaces,
  nodes and volumes — and anything in a cluster whose name looks like production (`prod`,
  `live`…) — asks you to type the name first (for several at once, what's being done).
  New objects are checked by the cluster before any of them is created.
- **Easy to take back.** Scaling, cordoning, suspending, pausing, image and label changes
  can be undone from their notification. The **Activity** log lists every change of the
  session with its command.
- **Read-only when you want it.** Turn changes off for a cluster in the cluster switcher, or
  for all clusters with `KUBESTACKS_READ_ONLY=1` (useful for shared machines); in a
  cluster, the chart's `readOnly: true` does it for everyone. It's enforced where
  KubeStacks talks to the cluster, not just in the interface. Shells count as changes; port
  forwards don't.

Shells run in a terminal in the pod's **Shell** tab (bash when the image has it, sh
otherwise). Port forwards listen on `localhost` only, are listed under the plug icon in the
header while they run, and stop when you stop them or quit.

## Usage history

Live usage comes from the metrics API (metrics-server), like `kubectl top`. History comes
from a Prometheus-compatible server in the cluster, reached through the API server's
service proxy with your own credentials, so nothing needs to be port-forwarded or exposed.

- **Found automatically.** KubeStacks looks among the cluster's services for Prometheus
  (kube-prometheus-stack, the Prometheus chart, kube-prometheus) and VictoriaMetrics
  (single-node `vmsingle` and the cluster version's `vmselect`), and uses the first that
  answers a query.
- **Or chosen.** Open **Metrics source** from the chip on any chart, or from the command
  palette, to pick a namespace, service, port and path (`/select/0/prometheus` for
  vmselect), test it, or turn history off for that cluster.
- **What it needs.** Your account needs `get` on `services/proxy` in the source's namespace.
  Charts use cAdvisor's `container_*` metrics; restarts come from kube-state-metrics, which
  also places pods on nodes when cAdvisor's series don't carry a `node` label.

## Custom resources

Every kind the cluster serves is in **API resources** (in the sidebar and the command
palette), like `kubectl api-resources`, with custom resources grouped by API group. The
sidebar stays short however many CRDs a cluster has: it keeps the custom resources you
opened last in that cluster, and the kinds you pin. ⌘K finds any kind by name, short name
or group.

- **What the cluster says.** Lists have the columns the API server prints for the kind (a
  CRD's printer columns), and objects a status read from the conventions most controllers
  follow: `Ready`-like conditions, kstatus' `Stalled` and `Reconciling`, a spec the
  controller hasn't caught up with, suspension, or a phase. Fields are explained by the
  kind's OpenAPI schema (Kubernetes 1.27 and later), and YAML edits are validated by it.
- **What a view adds.** A view gives a kind better columns and status, the facts that
  matter, links to related objects, and actions that patch it, all written as data.
  KubeStacks ships views for cert-manager, Argo CD and Rollouts, Flux, Gateway API,
  Karpenter, KEDA, External Secrets, the Prometheus operator, CloudNativePG, Istio, Velero
  and Crossplane; yours go in `~/.kubestacks/views` (or the folder in
  `KUBESTACKS_VIEWS_DIR`; in a cluster, the chart's `views`) and replace KubeStacks' for
  the same kind. [views.md](views.md) describes the format. Views can't run
  code: they only read fields and change objects with the patches they spell out, and
  every change shows its `kubectl` command and asks the cluster what you may do, like any
  other.
- **Scaling.** Kinds with the scale subresource (Argo Rollouts, say) can be scaled like
  Deployments.

## Helm releases

**Helm releases** (`G` then `H`) lists every release in the cluster, or the namespace you
picked, read from the Secrets (or ConfigMaps) Helm 3 and 4 keep them in, so looking needs
no helm and nothing beyond the right to list Secrets. A release shows its chart, the values
set for it (alone or merged with the chart's defaults), the objects its manifest makes with
their live status (and any that are missing), its notes, and its revisions, with a diff of
the values or the manifest between any two.

Changes go through `helm` (on the desktop, your own: on your `PATH`, or the one in
`KUBESTACKS_HELM`; in a cluster, the one in KubeStacks' image), so hooks, three-way merges
and Helm's own record of revisions work as they always do:

- **Upgrade** with new values, using the chart the release already runs (Helm stores it
  with the release, apart from subcharts) or another chart from a repository, an OCI
  registry or a folder, at any version the repository lists. KubeStacks runs it as a
  server-side dry run first and shows what the manifest would change, before anything
  does.
- **Roll back** to any earlier revision, seeing how much of its values and manifest differ.
- **Uninstall**, keeping the release's history if you want to roll it back into being.
- **Install** a chart found on [Artifact Hub](https://artifacthub.io) (or typed), starting
  from its default values, again reviewed as a dry run.
- **Charts on your computer** (in the desktop app), for the chart you're working on: choose a chart folder or
  a packaged `.tgz` (or type its path, `~/` included). KubeStacks shows what it is, warns
  when it's another chart than the release runs or an older version, checks it with
  `helm lint` against your values (again before every review), downloads missing subcharts
  (`helm dependency update`), and loads the values files beside it (`values-prod.yaml`,
  `ci/*.yaml`). The next upgrade of that release starts from the same chart.

Releases that Flux's helm-controller manages say so, link to their `HelmRelease`, and warn
that Flux will put back changes made any other way. Every change shows its `helm` command,
and a cluster you made read-only can't be changed with Helm either.
