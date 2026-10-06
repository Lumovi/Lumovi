# Changelog

All notable changes to Lumovi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

## [1.6.0] - 2026-10-06

An audit log of what's done through Lumovi, by whom, and how it went, kept as a chain anyone
can check; and, on a server, Access: who may do what through Lumovi, set by its admins, within
what Kubernetes RBAC allows.

### Added

- An audit log of what's done through Lumovi, by whom, from where, and how it went: changes
  (from the page, or AI assistants' with how they were approved: by whom, after how long, with
  their note, or made without asking where the rules allow it), Helm installs, upgrades,
  rollbacks and uninstalls, shells and node shells (with how long they ran), port-forwards,
  logs, Secrets and Helm releases' values read (or refused), sign-ins and sign-outs, sessions
  ending, assistants allowed, denied and let go (a refresh token used twice, refused), each tool
  an assistant calls, and changes to read-only, where node shells run, and AI permissions. Each
  change is described by the server, from what was asked (never from what the page says it is),
  with the kubectl or helm command that does the same; what a patch sets is named, never its
  values; Secrets' values, tokens and manifests' contents are never in it, nor what the cluster
  says in an error about a Secret.
- Events are chained: each holds its chain's id and the hash of the one before it, so changing
  one, or removing or putting one in between others, shows when it's checked: on the Audit page
  (every place it doesn't hold), or by anyone with the events, jq and SHA-256 (`jq -jcS
'del(.hash)' | sha256sum`). The newest's hash, compared with a copy sent elsewhere, shows what
  the chain alone can't: the newest removed, or all of it rewritten. Each event is a line of
  64 KiB at most, whatever it's about.
- The Audit page: search, filters (what kind, outcome, who, through the page or an assistant,
  cluster, how far back) kept in the address to share, a day at a time, as many as there are
  (it asks for older ones as it's scrolled), events coming in as they happen, everything about
  one (who, groups, from where and through what proxy, browser, session by a hash, the
  approval, the command, what it set, its place in the chain), export as CSV or JSON Lines
  (what a spreadsheet would run as a formula, as text), and a check of the chain. In the
  sidebar, the command palette, and from the activity menu and the AI assistants' Activity tab.
- Each object's Audit tab: who changed it (or read it, or opened a shell in it), and how it
  went, as it happens.
- On a server, each event is also a JSON line on its output (with `"type":"lumovi.audit"`), for
  the cluster's log collector (`LUMOVI_AUDIT_STDOUT=false` stops it), and can be sent to a
  webhook (`LUMOVI_AUDIT_WEBHOOK_URL`, its headers from a Secret, as JSON or NDJSON), in
  batches, tried again until it takes them; events that can't be kept or sent are counted, said
  in the log, recorded, and shown to auditors. Sign-ins that fail, which anyone can try, are
  recorded each up to 60 a minute, and counted past that. People see their own events; those in
  `LUMOVI_AUDITORS` (groups, or `user:` names) see everyone's. Its history is kept in
  `LUMOVI_AUDIT_DIR` (or `LUMOVI_DATA_DIR/audit`) for `LUMOVI_AUDIT_RETENTION_DAYS` (90), by one
  server alone (another sharing the folder waits, 30 seconds at most, for it to stop, then
  doesn't start), else in memory since it started (said on the page). `LUMOVI_AUDIT_LEVEL=changes`
  records changes, sign-ins and settings, but not what's opened and read.
- The desktop app keeps its own, for 90 days, as the computer's person and each cluster's
  kubeconfig user (in memory, and said why, if its folder can't be used).
- Helm chart: `audit` values: the level, auditors, the output, a volume for the history
  (`audit.persistence`, kept when the chart's uninstalled), how long it's kept, and a webhook.
- Access, on a server: who may do what through Lumovi, within what Kubernetes RBAC allows (never
  more). What everyone signed in gets; Lumovi's own groups (the identity provider's groups, so
  people who join or leave there do here, and people by name); profiles, each a level of
  changes, shells, node shells, logs, Secrets (hidden, keys only, values), Helm (upgrade, or
  install), AI assistants (off, changes ask first, as set) and the audit log (one's own, or
  everyone's); grants, which give groups a profile in some clusters and namespaces (by name,
  pattern or label), the most of them where several apply; and limits, which hold anyone they
  name back wherever they match, whatever grants give. The server decides: changes, shells,
  node shells, logs, Secrets (values withheld, or hidden), Helm releases (their values and
  manifests withheld where Secrets' are), and AI assistants (never more than their person may,
  and none for someone who may use them nowhere) are refused, said why, and recorded as refused.
- The Admin pages, for the admins `LUMOVI_ADMINS` names (groups, or `user:` names): groups, with
  who's in each as they last signed in, and the provider's groups seen at sign-in in the last
  30 days, to add and (Microsoft Entra ID's IDs) name; profiles side by side, with what shows
  Secret values or runs code on nodes marked; grants and limits, each with who it names and how
  far it reaches; someone checked anywhere, with which rule decides each; and every change,
  from the audit log. Changes are made to a draft, read back, and saved together; saving after
  someone else did is refused, not lost in theirs; leaving with something unsaved asks first.
  Said where groups don't arrive at sign-in, and how to send them. Every change is recorded
  (`access.changed`), with what it was before.
- Your access, for everyone: what they may do, cluster by cluster, and why (their groups, the
  grants that give them more, the limits that hold them back). Every refusal says why where it
  happens (an action, a shell, logs, a Secret, a release) and links to it; it's in the account
  menu and the command palette, with the Admin pages for admins (and in the sidebar).
- What admins set is kept in a ConfigMap (the chart's), `LUMOVI_DATA_DIR`, or memory, and read
  again every 15 seconds, so each replica follows; changed by hand where it's kept, it's recorded
  too, as changed outside Lumovi. `LUMOVI_ACCESS` says what the chart does, which admins see but
  can't change (`on` and `off`, as YAML reads them unquoted, are taken as meant). People named in
  a group, or as admins, are matched whatever the case of their name. With no admins, everyone
  may do all their RBAC allows, as before.
- Helm chart: `access.admins` and `access.policy`.

### Changed

- Helm chart: the audit history is on a volume by default, so the chart makes a
  PersistentVolumeClaim (2 GiB, the cluster's default storage class: a cluster without one
  needs `audit.persistence.storageClass`, or `audit.persistence.enabled: false`). With it, an
  upgrade stops the old pod before the new one starts (one writes the history at a time), and
  more than one replica needs `audit.persistence.enabled: false`.
- CI runs each platform's tests on four machines at once, not two.
- The end-to-end coverage CI requires is more than 95% of statements, branches, functions and
  lines (it was 100%), with every source file loaded by some test.
- AI rules kept in `LUMOVI_DATA_DIR` by two replicas: one's change no longer writes over the
  other's.

### Fixed

- AI rules kept in the chart's ConfigMap: saving them no longer takes the annotation that keeps
  the ConfigMap when the chart's uninstalled off it, nor its labels. Without it, an upgrade that
  turned assistants off deleted the ConfigMap, and everyone's AI rules with it.
- AI rules: an edit made just as a save landed (a matcher added, a rule's name typed) was
  sometimes lost, the page showing the rules as they were before for a moment.

## [1.5.0] - 2026-10-06

What AI assistants may do, and where: defaults, and rules for some clusters and namespaces,
which the tools keep to, on the desktop and on a server, where administrators set limits
nobody loosens.

### Added

- What AI assistants may do, and where: a Permissions tab, in the desktop app and on a server.
  Defaults say whether their changes ask you, are made without asking, or never are; whether
  they see Secrets' values, only their keys, or no Secrets; which env values they see (all,
  all but sensitive ones, or none); and whether they read logs. Rules say otherwise for some
  clusters and namespaces, by name, pattern (`tenant-*`) or label (`team=payments`), or leave
  one out (`!kube-system`), so one rule covers thousands; where rules overlap, the strictest
  wins. A namespace a rule hides isn't there for assistants. A change to a cluster's own
  objects (nodes, custom resource definitions, cluster roles, webhooks…) can reach every
  namespace, so it's decided as the strictest of them all: not made where one is hidden,
  refused or hides its Secrets. The tab counts what assistants
  see, change and read over every namespace, checks any one (and which rule decided), and
  shows what assistants are told as they start, and the tools keep to it all.
- On a server, each person's are kept in a ConfigMap the Helm chart makes (or a file under
  `LUMOVI_DATA_DIR`, or memory, said on the page), the same in every browser; and
  administrators set rules that are limits nobody's own loosen (`LUMOVI_ASSISTANT_RULES`, the
  chart's `assistants.rules`). A server of one cluster takes its labels for them from
  `LUMOVI_CLUSTER_LABELS` (the chart's `clusterLabels`). The page that allows an assistant
  says what it will be able to do.

### Changed

- AI assistants have a page of their own, in place of their dialog: Connect, your assistants
  (on a server), Permissions, and what they did (Activity).
- Env values that look sensitive (passwords, tokens, keys, URLs with credentials) are hidden
  from assistants, unless you show them. A change that would read a Secret into a workload
  (whose logs could show it) asks you, even where changes are made without asking, unless
  assistants may read Secrets' values there.
- The desktop app's Ask, Allow and Never for each cluster are rules now, as they were.
- `LUMOVI_ASSISTANT_CHANGES` (the chart's `assistants.changes` and `assistants.clusters`) are
  limits now: ask and never cap what people let their assistants do; allow leaves it to them,
  and they ask unless people say otherwise. The chart no longer sets them unless you do. So
  after upgrading, people may let their assistants change without asking, and read Secrets'
  values, which 1.4 didn't allow: to keep 1.4's limits, give the chart the rule
  `{ name: Limits, changes: ask, secrets: keys }` under `assistants.rules`.

## [1.4.0] - 2026-10-06

AI assistants for your team: on a Lumovi server, and across a fleet, they sign in as each
person, act with what that person may do, and ask them before changing anything.

### Added

- AI assistants on a Lumovi server, and across a fleet: Claude Code, Cursor, VS Code and other
  MCP clients connect at the server's address (`/mcp`) and sign in through Lumovi, as MCP's
  OAuth has them: Lumovi opens in the browser, the person signs in as they always do (a
  token, single sign-on or a proxy), and allows the assistant. It then acts as them, with
  their RBAC on every cluster and none of the clusters they made read-only, until they
  disconnect it in Lumovi or their session ends. The changes it asks for wait on their own
  pages for their answer, with a browser notification when the tab is elsewhere, and the
  server's log records each outcome. Assistants are on after upgrading, and each needs
  someone to allow it: administrators turn them off (`LUMOVI_ASSISTANTS`, the chart's
  `assistants.enabled`), and say what their changes do, for every cluster or each one
  (`LUMOVI_ASSISTANT_CHANGES`, like `ask,staging=allow,production=never`). Assistants are
  sent back only to the person's computer or an app, unless the administrator names sites
  (`LUMOVI_ASSISTANT_REDIRECT_HOSTS`). What they're allowed lives in the server's memory,
  so the chart keeps one replica while they're on; below a base path, its ingress routes the
  addresses assistants look for how to sign in at.

### Fixed

- The desktop app's bridge for assistants that start Lumovi themselves (stdio) connects only to
  Lumovi on this computer: a port in Lumovi's settings that named another host would have sent
  it the bridge's token.

## [1.3.0] - 2026-10-06

Your AI assistant, with you in charge: assistants read your clusters through Lumovi, and the
changes they ask for wait for your approval. And right-sizing for clusters of thousands of
namespaces.

### Added

- AI assistants, in the desktop app: Claude Code, Claude Desktop, Cursor, VS Code and other
  assistants that speak MCP read your clusters through Lumovi, and ask you before they change
  anything. They list and read objects (a Secret's keys, never its values), events and logs,
  and find what's wrong, with Lumovi's own reasons. The changes they ask for (applying a
  manifest, scaling, restarting, deleting) are checked by the cluster first, then wait in
  Lumovi with the diff they make, the assistant's reason, whose fields they'd take over (Helm's,
  Argo CD's…) and the `kubectl` command that does the same, for you to approve, or reject with
  a note the assistant reads; a notification says when one's waiting. A change is made only if
  it still does what you saw, and a deletion asks for the name where Lumovi's own Delete does.
  Unanswered, changes expire after five minutes. Each cluster says whether its assistants'
  changes are asked about, made without asking (deletions, and changes that take fields over
  from others, still ask), or never made; read-only clusters and your own RBAC always apply.
  The activity log shows each change, and whose it was. AI Assistants (the sidebar, the command
  palette or View) turns it on and sets assistants up: with a click for Claude Desktop, Cursor
  and VS Code, a command to paste for Claude Code. Lumovi listens on this computer only, for
  assistants with its token (kept in settings only you can read), and Claude Desktop starts
  Lumovi when it isn't running.

### Changed

- Right-sizing works on clusters of thousands of namespaces. It asks Prometheus about many
  namespaces at once, up to a thousand containers' worth, instead of one namespace at a time,
  biggest first: a cluster of 3,000 namespaces takes dozens of queries rather than 24,000. When
  Prometheus says a batch is too big (too many samples, or too slow), it's asked about in
  halves. What's measured shows while the rest is, with how far it's got, and the workloads
  come fifty a page.

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

[Unreleased]: https://github.com/Lumovi/Lumovi/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/Lumovi/Lumovi/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Lumovi/Lumovi/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Lumovi/Lumovi/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Lumovi/Lumovi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Lumovi/Lumovi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Lumovi/Lumovi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Lumovi/Lumovi/releases/tag/v1.0.0
