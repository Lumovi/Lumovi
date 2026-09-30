# Changelog

All notable changes to KubeStacks are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- First version: a read-only Kubernetes cluster viewer for macOS, Windows and Linux.
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
