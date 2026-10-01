# Changelog

All notable changes to KubeStacks are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- First version: a Kubernetes app for macOS, Windows and Linux.
- Actions: scale, restart, change images, roll back (Deployments, StatefulSets and
  DaemonSets), pause and resume rollouts, run CronJobs now, suspend and resume, cordon,
  uncordon and drain nodes, evict, restart and force-delete pods, change autoscaler ranges,
  expand volumes, edit labels, annotations and YAML (validated by a dry run and reviewed as
  a diff), and delete with a choice of what happens to dependents.
- Shells in containers, debug containers (`kubectl debug`) for pods, including those
  without a shell, and port forwards to pods and services, listed in the header.
- Custom resources, and every other kind the cluster serves, found through API discovery:
  all of them in **API resources** grouped by API group, the ones opened last and pinned
  ones in the sidebar (which stays short with hundreds of CRDs), with the API server's
  columns, a status read from the usual conventions, fields explained by the kind's
  OpenAPI schema, scaling through the scale subresource, and creating, editing and
  deleting like any other kind.
- Views: a kind's columns, status, details, links and actions described as data. Views
  for cert-manager, Argo CD and Rollouts, Flux, Gateway API, Karpenter, KEDA, External
  Secrets, the Prometheus operator, CloudNativePG, Istio, Velero and Crossplane are
  included, and your own in `~/.kubestacks/views` replace them (see docs/views.md).
- Workloads: every Deployment, StatefulSet, DaemonSet, Job, CronJob and unmanaged pod in
  one list, with status, ready pods, autoscaler ranges and usage per workload, filters by
  health and labels, and bulk actions across kinds. Each
  kind's own list is a tab away. The sidebar leads with Workloads and Pods; ReplicaSets and
  autoscalers are reached from their owners and ⌘K.
- Logs streamed as they're written (`kubectl logs -f`): a pod's, or every pod's of a
  workload or service merged by time with each line marked by its pod and color, new pods
  joining and dropped streams picked up where they left off. Search, level and pod filters,
  ANSI colors, time ranges, the previous container, and copy or download.
- Helm releases: every release read from where Helm 3 and 4 keep them (Secrets or
  ConfigMaps, no helm needed), with their status, values (alone or with the chart's
  defaults), the objects they made and their live status, notes, and revisions diffed
  against each other. Upgrades with new values (with the stored chart, or one from a
  repository, an OCI registry or a folder, at a version the repository lists), installs of
  charts found on Artifact Hub, rollbacks and uninstalls run with your own helm, after a
  server-side dry run shows what would change. Releases Flux manages link to their
  HelmRelease and warn before changing. Charts on this computer (a folder or a .tgz, chosen
  or typed) are checked with helm lint, can have their subcharts downloaded, and offer the
  values files beside them; each release remembers the one it was deployed from.
- Usage history from Prometheus or VictoriaMetrics, found among the cluster's services and
  reached through the API server: a Metrics page that ranks namespaces, workloads, pods or
  nodes by CPU, memory, network or restarts over 15 minutes to 7 days, with stacked or line
  charts, zoom by dragging, a distribution to filter by and a sortable table; a Metrics tab
  on pods, workloads and nodes, against requests, limits and allocatable capacity; and an
  hour of history on the overview. The source can be chosen, tested or turned off per
  cluster.
- Bulk actions: pick rows with checkboxes, Shift-click, `X` or `⌘A`, then restart, cordon,
  uncordon, suspend, resume or delete them together, with progress per object and a retry
  for failures.
- Create from YAML (`⌘N`): templates for common kinds, several objects at once, all checked
  by the cluster before any is created.
- Guard rails for changes: permission checks before acting, the equivalent `kubectl` command
  in every dialog, typed confirmation for risky deletes and production-looking clusters,
  undo from notifications, an activity log, and a read-only switch per cluster
  (`KUBESTACKS_READ_ONLY` for all of them).
- Cluster picker with the connection status of every kubeconfig context.
- Overview with node, pod, workload and warning health, CPU and memory usage against
  capacity (with requests, limits and live trends), per-node usage, and lists of the objects
  that need attention, recent warnings and the busiest pods.
- Tables for 19 resource kinds with health status, sorting, filtering, label selectors,
  pagination and virtual scrolling. Lists load in chunks and are capped (5,000 objects by
  default, `KUBESTACKS_MAX_LIST_ITEMS`) so huge clusters stay fast. Filters, sorting and
  the page live in the URL, so Back and Forward restore them.
- Resizable detail panel next to the list, with kind-specific details, containers,
  conditions, labels, related pods, events, searchable logs and YAML. Secret values stay
  hidden until revealed.
- Keyboard shortcuts for every view, arrow-key navigation in lists, a shortcut sheet (`?`)
  and a native menu with the same commands.
- Command palette that also finds loaded objects, namespace picker, cluster switcher with
  recent clusters, and light and dark themes.
- Smooth page transitions that respect reduced motion.
- Error pages with details to copy or report, a banner when a cluster stops responding,
  stale-data notices that keep the last data on screen, and automatic recovery when the
  window's page crashes.
- The window remembers its size and position.
- Support for multiple kubeconfig files, client certificates, tokens and exec credential
  plugins, including loading the login shell's `PATH` on macOS and Linux.

[Unreleased]: https://github.com/kotapeter/kubestacks/commits/main
