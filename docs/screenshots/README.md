<!-- Written by npm run screenshots (scripts/screenshots/): change it there. -->

# Screenshots

Every screen of KubeStacks worth showing, light and dark, for the README, the docs and the website. They're taken of the mock clusters the tests use, so they're the same every time, and refreshing them changes only the screens that did.

## Using them

Each comes as WebP in two sizes:

| File                     | Size                                            |
| ------------------------ | ----------------------------------------------- |
| `<name>-<theme>.webp`    | 2880 × 1800, lossless, for high-density screens |
| `<name>-<theme>-1x.webp` | 1440 × 900, near-lossless                       |

Names don't change, so a link keeps showing the latest screenshot. In this repository, link to the file itself. Elsewhere, link to [jsDelivr](https://www.jsdelivr.com), which serves this repository's `main` (its cache is cleared for every screenshot that changes there):

```
https://cdn.jsdelivr.net/gh/KubeStacks/KubeStacks@main/docs/screenshots/overview-dark.webp
```

To show the reader's theme, at their screen's density:

```html
<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="
      https://cdn.jsdelivr.net/gh/KubeStacks/KubeStacks@main/docs/screenshots/overview-dark-1x.webp 1440w,
      https://cdn.jsdelivr.net/gh/KubeStacks/KubeStacks@main/docs/screenshots/overview-dark.webp    2880w
    "
  />
  <img
    src="https://cdn.jsdelivr.net/gh/KubeStacks/KubeStacks@main/docs/screenshots/overview-light-1x.webp"
    srcset="
      https://cdn.jsdelivr.net/gh/KubeStacks/KubeStacks@main/docs/screenshots/overview-light-1x.webp 1440w,
      https://cdn.jsdelivr.net/gh/KubeStacks/KubeStacks@main/docs/screenshots/overview-light.webp    2880w
    "
    width="1440"
    height="900"
    alt="A cluster's overview: nodes, pods and workloads, CPU and memory with their last hour, and what needs attention."
  />
</picture>
```

[`screenshots.json`](screenshots.json) lists them all, with their titles and descriptions (good alt text).

## Taking them again

The **Screenshots** workflow (Actions → Screenshots → Run workflow) takes them all on macOS and proposes the ones that changed in a pull request. Or, on a Mac:

```sh
npm run screenshots                    # all of them
npm run screenshots -- overview pods   # only these
npm run screenshots -- --prune         # and remove ones no longer taken
```

Screens are listed in [`scripts/screenshots/screens.ts`](../../scripts/screenshots/screens.ts): a name, a description, where to start and what to do there. Once published, keep a screen's name: the website and docs link to it.

## All of them

### Clusters

`clusters`: Every cluster in the kubeconfig, ready to open.

| Light                                                                                             | Dark                                                                                            |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [![Every cluster in the kubeconfig, ready to open.](clusters-light-1x.webp)](clusters-light.webp) | [![Every cluster in the kubeconfig, ready to open.](clusters-dark-1x.webp)](clusters-dark.webp) |

### Overview

`overview`: A cluster's overview: nodes, pods and workloads, CPU and memory with their last hour, and what needs attention.

| Light                                                                                                                                                             | Dark                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![A cluster's overview: nodes, pods and workloads, CPU and memory with their last hour, and what needs attention.](overview-light-1x.webp)](overview-light.webp) | [![A cluster's overview: nodes, pods and workloads, CPU and memory with their last hour, and what needs attention.](overview-dark-1x.webp)](overview-dark.webp) |

### Workloads

`workloads`: Every workload, whatever its kind, in one list, with its health.

| Light                                                                                                                | Dark                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [![Every workload, whatever its kind, in one list, with its health.](workloads-light-1x.webp)](workloads-light.webp) | [![Every workload, whatever its kind, in one list, with its health.](workloads-dark-1x.webp)](workloads-dark.webp) |

### A deployment

`deployment`: A deployment that's failing, with its pods and why they're restarting.

| Light                                                                                                                        | Dark                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [![A deployment that's failing, with its pods and why they're restarting.](deployment-light-1x.webp)](deployment-light.webp) | [![A deployment that's failing, with its pods and why they're restarting.](deployment-dark-1x.webp)](deployment-dark.webp) |

### Logs

`logs`: The logs of every pod of a deployment, merged as they happened.

| Light                                                                                                     | Dark                                                                                                    |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [![The logs of every pod of a deployment, merged as they happened.](logs-light-1x.webp)](logs-light.webp) | [![The logs of every pod of a deployment, merged as they happened.](logs-dark-1x.webp)](logs-dark.webp) |

### Pods

`pods`: Every pod, its status and restarts, with the failing ones first.

| Light                                                                                                      | Dark                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [![Every pod, its status and restarts, with the failing ones first.](pods-light-1x.webp)](pods-light.webp) | [![Every pod, its status and restarts, with the failing ones first.](pods-dark-1x.webp)](pods-dark.webp) |

### A pod

`pod`: A pod's details next to the list: its containers, their usage and state.

| Light                                                                                                            | Dark                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [![A pod's details next to the list: its containers, their usage and state.](pod-light-1x.webp)](pod-light.webp) | [![A pod's details next to the list: its containers, their usage and state.](pod-dark-1x.webp)](pod-dark.webp) |

### Shell

`shell`: A shell in a running container.

| Light                                                                       | Dark                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [![A shell in a running container.](shell-light-1x.webp)](shell-light.webp) | [![A shell in a running container.](shell-dark-1x.webp)](shell-dark.webp) |

### Editing YAML

`yaml`: A change to a ConfigMap's YAML, checked by the cluster and shown before it's saved.

| Light                                                                                                                         | Dark                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [![A change to a ConfigMap's YAML, checked by the cluster and shown before it's saved.](yaml-light-1x.webp)](yaml-light.webp) | [![A change to a ConfigMap's YAML, checked by the cluster and shown before it's saved.](yaml-dark-1x.webp)](yaml-dark.webp) |

### Several at once

`bulk`: Several pods picked, to act on them at once.

| Light                                                                                  | Dark                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [![Several pods picked, to act on them at once.](bulk-light-1x.webp)](bulk-light.webp) | [![Several pods picked, to act on them at once.](bulk-dark-1x.webp)](bulk-dark.webp) |

### Scaling

`scale`: Scaling a deployment, with what will change.

| Light                                                                                    | Dark                                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [![Scaling a deployment, with what will change.](scale-light-1x.webp)](scale-light.webp) | [![Scaling a deployment, with what will change.](scale-dark-1x.webp)](scale-dark.webp) |

### Create from YAML

`create`: Creating resources from YAML, checked as it's typed.

| Light                                                                                              | Dark                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [![Creating resources from YAML, checked as it's typed.](create-light-1x.webp)](create-light.webp) | [![Creating resources from YAML, checked as it's typed.](create-dark-1x.webp)](create-dark.webp) |

### Metrics

`metrics`: Usage over the last six hours from Prometheus, by namespace.

| Light                                                                                                        | Dark                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [![Usage over the last six hours from Prometheus, by namespace.](metrics-light-1x.webp)](metrics-light.webp) | [![Usage over the last six hours from Prometheus, by namespace.](metrics-dark-1x.webp)](metrics-dark.webp) |

### A pod's usage

`pod-metrics`: A pod's CPU and memory over time, against its requests and limits.

| Light                                                                                                                      | Dark                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [![A pod's CPU and memory over time, against its requests and limits.](pod-metrics-light-1x.webp)](pod-metrics-light.webp) | [![A pod's CPU and memory over time, against its requests and limits.](pod-metrics-dark-1x.webp)](pod-metrics-dark.webp) |

### Nodes

`nodes`: Nodes, their usage and conditions: one under memory pressure, one not ready.

| Light                                                                                                                    | Dark                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| [![Nodes, their usage and conditions: one under memory pressure, one not ready.](nodes-light-1x.webp)](nodes-light.webp) | [![Nodes, their usage and conditions: one under memory pressure, one not ready.](nodes-dark-1x.webp)](nodes-dark.webp) |

### A node

`node`: A node under memory pressure, with what runs on it and ways to drain it.

| Light                                                                                                              | Dark                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [![A node under memory pressure, with what runs on it and ways to drain it.](node-light-1x.webp)](node-light.webp) | [![A node under memory pressure, with what runs on it and ways to drain it.](node-dark-1x.webp)](node-dark.webp) |

### Events

`events`: What happened in the cluster, warnings first.

| Light                                                                                       | Dark                                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [![What happened in the cluster, warnings first.](events-light-1x.webp)](events-light.webp) | [![What happened in the cluster, warnings first.](events-dark-1x.webp)](events-dark.webp) |

### Services

`services`: Services with their ports and endpoints.

| Light                                                                                      | Dark                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| [![Services with their ports and endpoints.](services-light-1x.webp)](services-light.webp) | [![Services with their ports and endpoints.](services-dark-1x.webp)](services-dark.webp) |

### Port forwarding

`port-forward`: Forwarding a local port to a service.

| Light                                                                                           | Dark                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [![Forwarding a local port to a service.](port-forward-light-1x.webp)](port-forward-light.webp) | [![Forwarding a local port to a service.](port-forward-dark-1x.webp)](port-forward-dark.webp) |

### A secret

`secret`: A secret's keys, hidden until asked for.

| Light                                                                                  | Dark                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [![A secret's keys, hidden until asked for.](secret-light-1x.webp)](secret-light.webp) | [![A secret's keys, hidden until asked for.](secret-dark-1x.webp)](secret-dark.webp) |

### Storage

`storage`: Persistent volume claims, their capacity and what uses them.

| Light                                                                                                        | Dark                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| [![Persistent volume claims, their capacity and what uses them.](storage-light-1x.webp)](storage-light.webp) | [![Persistent volume claims, their capacity and what uses them.](storage-dark-1x.webp)](storage-dark.webp) |

### API resources

`api-resources`: Every kind the cluster serves, custom resources included.

| Light                                                                                                                 | Dark                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [![Every kind the cluster serves, custom resources included.](api-resources-light-1x.webp)](api-resources-light.webp) | [![Every kind the cluster serves, custom resources included.](api-resources-dark-1x.webp)](api-resources-dark.webp) |

### A custom resource

`custom-resource`: A cert-manager certificate, shown with KubeStacks' view of it.

| Light                                                                                                                          | Dark                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| [![A cert-manager certificate, shown with KubeStacks' view of it.](custom-resource-light-1x.webp)](custom-resource-light.webp) | [![A cert-manager certificate, shown with KubeStacks' view of it.](custom-resource-dark-1x.webp)](custom-resource-dark.webp) |

### Helm releases

`helm-releases`: Every Helm release, its chart, version and status.

| Light                                                                                                          | Dark                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [![Every Helm release, its chart, version and status.](helm-releases-light-1x.webp)](helm-releases-light.webp) | [![Every Helm release, its chart, version and status.](helm-releases-dark-1x.webp)](helm-releases-dark.webp) |

### A Helm release

`helm`: A Helm release's history, ready to roll back.

| Light                                                                                   | Dark                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [![A Helm release's history, ready to roll back.](helm-light-1x.webp)](helm-light.webp) | [![A Helm release's history, ready to roll back.](helm-dark-1x.webp)](helm-dark.webp) |

### Upgrading a release

`helm-upgrade`: Upgrading a Helm release with new values.

| Light                                                                                               | Dark                                                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [![Upgrading a Helm release with new values.](helm-upgrade-light-1x.webp)](helm-upgrade-light.webp) | [![Upgrading a Helm release with new values.](helm-upgrade-dark-1x.webp)](helm-upgrade-dark.webp) |

### Installing a chart

`helm-install`: Finding a chart on Artifact Hub to install.

| Light                                                                                                 | Dark                                                                                                |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [![Finding a chart on Artifact Hub to install.](helm-install-light-1x.webp)](helm-install-light.webp) | [![Finding a chart on Artifact Hub to install.](helm-install-dark-1x.webp)](helm-install-dark.webp) |

### Command palette

`command-palette`: Finding anything in the cluster, or anything to do, from the keyboard.

| Light                                                                                                                                  | Dark                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [![Finding anything in the cluster, or anything to do, from the keyboard.](command-palette-light-1x.webp)](command-palette-light.webp) | [![Finding anything in the cluster, or anything to do, from the keyboard.](command-palette-dark-1x.webp)](command-palette-dark.webp) |

### Keyboard shortcuts

`shortcuts`: Every keyboard shortcut.

| Light                                                                        | Dark                                                                       |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [![Every keyboard shortcut.](shortcuts-light-1x.webp)](shortcuts-light.webp) | [![Every keyboard shortcut.](shortcuts-dark-1x.webp)](shortcuts-dark.webp) |

### Deleting safely

`delete`: Deleting in a production cluster asks for its name first.

| Light                                                                                                   | Dark                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [![Deleting in a production cluster asks for its name first.](delete-light-1x.webp)](delete-light.webp) | [![Deleting in a production cluster asks for its name first.](delete-dark-1x.webp)](delete-dark.webp) |

### Read-only

`read-only`: A cluster made read-only: KubeStacks won't change anything in it until allowed.

| Light                                                                                                                               | Dark                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [![A cluster made read-only: KubeStacks won't change anything in it until allowed.](read-only-light-1x.webp)](read-only-light.webp) | [![A cluster made read-only: KubeStacks won't change anything in it until allowed.](read-only-dark-1x.webp)](read-only-dark.webp) |

### An unreachable cluster

`unreachable`: A cluster that doesn't answer, and what to try.

| Light                                                                                                   | Dark                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [![A cluster that doesn't answer, and what to try.](unreachable-light-1x.webp)](unreachable-light.webp) | [![A cluster that doesn't answer, and what to try.](unreachable-dark-1x.webp)](unreachable-dark.webp) |

### Thousands of pods

`large-cluster`: Thousands of pods, listed as fast as a handful.

| Light                                                                                                       | Dark                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [![Thousands of pods, listed as fast as a handful.](large-cluster-light-1x.webp)](large-cluster-light.webp) | [![Thousands of pods, listed as fast as a handful.](large-cluster-dark-1x.webp)](large-cluster-dark.webp) |

### Signing in with a token

`server-sign-in`, served from a cluster: KubeStacks served from a cluster: signing in with a token.

| Light                                                                                                                    | Dark                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| [![KubeStacks served from a cluster: signing in with a token.](server-sign-in-light-1x.webp)](server-sign-in-light.webp) | [![KubeStacks served from a cluster: signing in with a token.](server-sign-in-dark-1x.webp)](server-sign-in-dark.webp) |

### Single sign-on

`server-single-sign-on`, served from a cluster: KubeStacks served from a cluster: signing in with single sign-on.

| Light                                                                                                                                         | Dark                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [![KubeStacks served from a cluster: signing in with single sign-on.](server-single-sign-on-light-1x.webp)](server-single-sign-on-light.webp) | [![KubeStacks served from a cluster: signing in with single sign-on.](server-single-sign-on-dark-1x.webp)](server-single-sign-on-dark.webp) |

### Signed in

`server-account`, served from a cluster: KubeStacks served from a cluster: who's signed in, and their groups.

| Light                                                                                                                              | Dark                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [![KubeStacks served from a cluster: who's signed in, and their groups.](server-account-light-1x.webp)](server-account-light.webp) | [![KubeStacks served from a cluster: who's signed in, and their groups.](server-account-dark-1x.webp)](server-account-dark.webp) |
