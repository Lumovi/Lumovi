# Changelog

All notable changes to Lumovi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

## [1.2.0] - 2026-10-05

Hands on: shells on nodes, and terminals on this computer with kubectl pointed at the cluster.

### Added

- Shells on nodes: a node's Shell tab starts a privileged pod on it and opens a shell on the
  node itself, in its own namespaces (root on the node), or in the pod, with the node's files
  under /host; the pod is deleted when the shell ends. It says what it will do before it
  starts, shows each step as it happens, and says what went wrong in words that say what to
  do: an image the node can't pull, a namespace whose Pod Security doesn't allow privileged
  pods, a node with no shell of its own (Talos, Bottlerocket). As with `kubectl debug node`,
  each person's RBAC decides. Where the pods run and their image are settings, for each
  cluster; on a server, `LUMOVI_NODE_SHELL`, `LUMOVI_NODE_SHELL_NAMESPACE` and
  `LUMOVI_NODE_SHELL_IMAGE` (the chart's `nodeShell` values) set them, or turn node shells
  off.
- Terminals on this computer, in the desktop app: a bar along the bottom of a cluster's
  pages, always there, opens into a dock of them (or `` ⌃` ``, View → Terminal, the command
  palette; `` ⌃⇧` `` opens another). Each tab is your own shell with kubectl, helm and the
  rest pointed at a cluster and namespace, in that terminal only. Its kubeconfig comes first
  in `KUBECONFIG`, so credentials stay in your files. Tabs can be renamed, and in a terminal
  the keys are a terminal's: on macOS, `⌘T` (or `⌘N`) opens another, `⌘W` closes one, `⌘K`
  clears it and `⌘⇧[` and `⌘⇧]` move between them; on Windows and Linux, `Ctrl+Shift+T`,
  `Ctrl+Shift+W` and `Ctrl+PageUp`/`Ctrl+PageDown`. Prompts show their icons (Nerd Fonts',
  which Lumovi brings) without a font to install. Every action's equivalent command can be
  pasted into one, on one line, to read, change and run with Enter.

## [1.1.0] - 2026-10-05

Fleet: one Lumovi for many clusters, private ones too, running in a cluster, on a VM or on a
platform like Sevalla.

### Added

- Fleet: one Lumovi for many clusters, in a browser. Each person sees every cluster as their
  own RBAC there allows: Lumovi impersonates them, or passes their own token on to clusters
  that trust the identity provider. Signing in is with single sign-on or a proxy. Its home
  page sums up each cluster as its overview would (nodes, pods, workloads, warnings, CPU and
  memory, its version and how fast it answers), puts what needs attention first, and says
  why a cluster can't be reached. It filters by status and labels, groups by a label, and
  finds a workload by name or namespace in every cluster. The switcher and `⌘K` / `Ctrl+K` move between
  clusters, and back to all of them. See [Fleet](https://docs.lumovi.dev/server/fleet).
- A fleet's clusters come from a kubeconfig (`LUMOVI_FLEET_KUBECONFIG`, as YAML or base64 on
  one line, or files read again as they change), from Secrets in the cluster Lumovi runs in
  (its own, Cluster API's and Argo CD's), and from that cluster itself. A context's
  `lumovi.dev` extension, or a Secret's annotations, give a cluster labels, the groups who
  see it, and whether people's own tokens are passed on.
- Agents for clusters Lumovi can't reach: an agent in the cluster dials out to Lumovi over a
  WebSocket, and relays its connections to the API server. TLS runs from Lumovi to the API
  server through it, so the agent passes on only what it can't read. It reconnects on its
  own, also when its connection goes quiet, and passes on its service account's token again
  when Kubernetes rotates it.
- The Helm chart installs a fleet (`fleet`), what a cluster needs to join one (`mode: member`:
  a service account that may only impersonate, and its token, with the kubeconfig entry
  printed after installing), or an agent (`mode: agent`).
- Lumovi runs without Kubernetes on platforms that set `PORT`, like Sevalla: it listens on
  `PORT` unless `LUMOVI_PORT` is set, and takes every setting from the environment.
- `npm run dev:server -- --fleet` serves a fleet of the mock clusters, signed in to with a
  mock single sign-on.

### Fixed

- Views from the Helm chart's `views` value are used: Kubernetes mounts them as links, which
  were left out. A view file that can't be read is listed as a problem, and the rest load.
- The Map no longer says "Not found" for a Gateway or a Service in another namespace that a
  route refers to, as shared gateways are: it shows them, and they open.
- Right-sizing loads when the VerticalPodAutoscaler is installed but its autoscalers can't be
  listed (it says what that means), and for accounts that can't list nodes.
- Escape closes a Helm release's panel, as its close button says.
- The Metrics page's histogram counts in the singular when it should: "1 namespace", not
  "1 namespaces".

## [1.0.0] - 2026-10-04

The first version of Lumovi, the Kubernetes dashboard that was called KubeStacks.

### Added

- A desktop app for macOS, Windows and Linux, for every cluster in your kubeconfig: multiple
  kubeconfig files, client certificates, tokens and exec credential plugins, including the
  login shell's `PATH` on macOS and Linux. It updates itself: new versions download in the
  background and install when you restart or quit, with a notice when one is ready
  (**Help → Check for Updates…** looks right away).
- Lumovi in your cluster: a container image (`ghcr.io/lumovi/lumovi`) and a Helm chart
  (`oci://ghcr.io/lumovi/charts/lumovi`) serve the same app as a dashboard for the cluster,
  opened in a browser. People sign in with a token the cluster accepts, with single sign-on
  (OpenID Connect), or through an authenticating proxy, and see and change what their own
  RBAC allows. With single sign-on, Lumovi impersonates people, or, when the API server
  trusts the provider itself, passes their own tokens on (and renews them). Pages have
  addresses that can be shared. See [docs.lumovi.dev](https://docs.lumovi.dev/server/overview).
- Cluster picker with the connection status of every kubeconfig context.
- Overview with node, pod, workload and warning health, CPU and memory usage against
  capacity (with requests, limits and live trends), per-node usage, and lists of the objects
  that need attention, recent warnings and the busiest pods.
- Tables for every resource kind with health status, sorting, filtering, label selectors,
  pagination and virtual scrolling. Lists load in chunks and are capped (5,000 objects by
  default, `LUMOVI_MAX_LIST_ITEMS`) so huge clusters stay fast. Filters, sorting and the page
  live in the URL, so Back and Forward restore them.
- Resizable detail panel next to the list, with kind-specific details, containers,
  conditions, labels, related pods, events, searchable logs and YAML. Secret values stay
  hidden until revealed. Its tabs scroll sideways when there are more than fit.
- Workloads: every Deployment, StatefulSet, DaemonSet, Job, CronJob and unmanaged pod in one
  list, with status, ready pods, autoscaler ranges and usage per workload, filters by health
  and labels, and bulk actions across kinds. Each kind's own list is a tab away.
- Logs streamed as they're written (`kubectl logs -f`): a pod's, or every pod's of a workload
  or service merged by time with each line marked by its pod and color, new pods joining and
  dropped streams picked up where they left off. Search, level and pod filters, ANSI colors,
  time ranges, the previous container, and copy or download.
- A Map tab for every object: above it, what leads to it (gateways, routes, ingresses,
  services, autoscalers, network policies and disruption budgets); below, what it owns, uses
  and runs on (pods, ConfigMaps, Secrets, service accounts, volume claims, volumes, storage
  classes and nodes), a few steps out. A controller's pods are one card, one per revision of a
  Deployment, and open into each pod; what an object refers to that doesn't exist shows as
  missing, and what nothing refers to says so. Pointing at a card traces its chain; clicking
  one opens its own map. Custom resources are mapped by their owners and their views'
  relations.
- Usage history from Prometheus or VictoriaMetrics, found among the cluster's services and
  reached through the API server: a Metrics page that ranks namespaces, workloads, pods or
  nodes by CPU, memory, network or restarts over 15 minutes to 7 days, with stacked or line
  charts, zoom by dragging, a distribution to filter by and a sortable table; a Metrics tab on
  pods, workloads and nodes, against requests, limits and allocatable capacity; and an hour
  of history on the overview. The source can be chosen, tested or turned off per cluster.
- Right-sizing, a tab of Metrics: what each Deployment, StatefulSet and DaemonSet should
  request, from the last week of its usage. CPU requests cover the 95th percentile of each
  container's use and memory requests its peak, with 15% headroom. Containers that were
  OOM-killed get more memory and are never cut, CPU limits that throttle are raised (limits
  are never lowered), requests a HorizontalPodAutoscaler scales on stay as they are, and
  workloads a VerticalPodAutoscaler manages are left to it. Each recommendation says why,
  charts the week against the request, the recommendation and the limit, and is applied once
  the API server has checked it, with undo.
- Helm releases: every release read from where Helm 3 and 4 keep them (Secrets or
  ConfigMaps, no helm needed), with their status, values (alone or with the chart's
  defaults), the objects they made and their live status, notes, and revisions diffed against
  each other. Upgrades with new values (with the stored chart, or one from a repository, an
  OCI registry or a folder, at a version the repository lists), installs of charts found on
  Artifact Hub, rollbacks and uninstalls run with your own helm, after a server-side dry run
  shows what would change. Releases Flux manages link to their HelmRelease and warn before
  changing. Charts on this computer (a folder or a .tgz) are checked with helm lint, can have
  their subcharts downloaded, and offer the values files beside them.
- Custom resources, and every other kind the cluster serves, found through API discovery: all
  of them in **API resources** grouped by API group, the ones opened last and pinned ones in
  the sidebar (which stays short with hundreds of CRDs), with the API server's columns, a
  status read from the usual conventions, fields explained by the kind's OpenAPI schema,
  scaling through the scale subresource, and creating, editing and deleting like any other
  kind.
- Views: a kind's columns, status, details, links, related objects and actions described as
  data. View actions can ask for values first (text, a number or a choice) and can create
  objects, shown as YAML before they're created: run a pipeline or a workflow again, back up a
  database now, approve a Kafka rebalance. Views relate objects to the ones that belong to
  them, a tab each in the detail panel, with logs and usage history for related pods. Your
  own views in `~/.lumovi/views` add to Lumovi's or replace them.
- Add-ons: every tool a cluster runs gets an entry in the sidebar, leading to everything of
  its kinds in one list (what's failing first) with a tab for each kind. Lumovi has add-ons
  for Argo CD, Argo Rollouts, Argo Workflows, cert-manager, Cilium, CloudNativePG, Cluster
  API, Crossplane, Elastic (ECK), External Secrets, Flux, Gatekeeper, Gateway API, Istio,
  Karpenter, KEDA, Knative Serving, KubeVirt, Kyverno, Linkerd, Longhorn, the Prometheus
  operator, Rook Ceph, Sealed Secrets, Strimzi, Tekton, Traefik, Trivy, Velero,
  VictoriaMetrics, the Vertical Pod Autoscaler and volume snapshots; you can write your own,
  or replace Lumovi's.
- Karpenter's add-on opens on an overview: its node pools against their limits, the nodes
  they launched and the ones launching, the mix of instance types, capacity types and zones,
  what's being disrupted and why, and the pods waiting for a node.
- Actions: scale, restart, change images, roll back (Deployments, StatefulSets and
  DaemonSets), pause and resume rollouts, run CronJobs now, suspend and resume, cordon,
  uncordon and drain nodes, evict, restart and force-delete pods, change autoscaler ranges,
  expand volumes, edit labels, annotations and YAML (validated by a dry run and reviewed as a
  diff), and delete with a choice of what happens to dependents.
- Shells in containers, debug containers (`kubectl debug`) for pods, including those without
  a shell, and port forwards to pods and services, listed in the header.
- Bulk actions: pick rows with checkboxes, Shift-click, `X` or `⌘A`, then restart, cordon,
  uncordon, suspend, resume or delete them together, with progress per object and a retry for
  failures.
- Create from YAML (`⌘N`): templates for common kinds, several objects at once, all checked by
  the cluster before any is created.
- Guard rails for changes: permission checks before acting, the equivalent `kubectl` command
  in every dialog, typed confirmation for risky deletes and production-looking clusters, undo
  from notifications, an activity log, and a read-only switch per cluster
  (`LUMOVI_READ_ONLY` for all of them).
- Keyboard shortcuts for every view, arrow-key navigation in lists, a shortcut sheet (`?`) and
  a native menu with the same commands. A command palette that also finds loaded objects, a
  namespace picker, a cluster switcher with recent clusters, and light and dark themes.
- Error pages with details to copy or report, a banner when a cluster stops responding,
  stale-data notices that keep the last data on screen, and automatic recovery when the
  window's page crashes. The window remembers its size and position, and page transitions
  respect reduced motion.

[Unreleased]: https://github.com/Lumovi/Lumovi/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/Lumovi/Lumovi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Lumovi/Lumovi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Lumovi/Lumovi/releases/tag/v1.0.0
