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
- Tables for 19 resource kinds with health status, sorting, filtering and virtual scrolling.
- Detail panel with kind-specific details, containers, conditions, labels, related pods,
  events, logs and YAML. Secret values stay hidden until revealed.
- Command palette, namespace picker, cluster switcher, and light and dark themes.
- Support for multiple kubeconfig files, client certificates, tokens and exec credential
  plugins, including loading the login shell's `PATH` on macOS and Linux.
