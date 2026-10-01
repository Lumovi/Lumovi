# Views

KubeStacks shows any kind the cluster serves. Kinds without a page of their own (custom
resources, and Kubernetes' less common kinds) get the columns the API server prints for
them, like `kubectl get`, and a status read from their conditions. A **view** does better:
it says which columns matter for a kind, how to tell whether an object is healthy, which
facts to show, which objects it relates to, and which changes people make to it.

Views are YAML, and data only. They read fields with JSONPath, the way CRD printer columns
do, and change objects only with the patches they spell out. A view can't run code, and
its actions go through the same checks as KubeStacks' own: the cluster is asked first
whether you may make the change, the equivalent `kubectl` command is shown, and a
read-only cluster stays read-only.

## Where views come from

- **KubeStacks' own**, in [src/renderer/src/views](../src/renderer/src/views): cert-manager,
  Argo CD and Rollouts, Flux, Gateway API, Karpenter, KEDA, External Secrets, the
  Prometheus operator, CloudNativePG, Istio, Velero, Crossplane, and CustomResourceDefinitions.
- **Yours**, in `~/.kubestacks/views` (or the folder in `KUBESTACKS_VIEWS_DIR`): every
  `.yaml` and `.yml` file, one or more views each, separated by `---`. Your view of a kind
  replaces KubeStacks'. Press ⌘R (Ctrl+R) in KubeStacks after changing them.

**API resources** (in the sidebar) shows which view each kind uses, and lists anything
wrong with your views: a view with a problem isn't used at all, and the problem says where
it is.

## An example

```yaml
apiVersion: kubestacks.dev/v1alpha1
kind: View
metadata:
  name: cert-manager-certificates
spec:
  # The kinds it's for: an API group and a kind (no group for the core group's kinds).
  kinds:
    - { group: cert-manager.io, kind: Certificate }
  # One of the icons listed below.
  icon: shield-check

  # List columns, after the name and status; they replace the API server's.
  columns:
    - { name: Hosts, path: '.spec.dnsNames[*]' }
    - { name: Secret, path: .spec.secretName }
    - { name: Expires, path: .status.notAfter, type: date }

  # The status: the first rule that applies decides it. With no rule that applies,
  # KubeStacks reads the status from the usual conventions.
  status:
    - when: { path: '.status.conditions[?(@.type=="Ready")].status', equals: 'True' }
      health: healthy
      label: Ready
    - when: { path: '.status.conditions[?(@.type=="Ready")].status', equals: 'False' }
      health: critical
      label: '{{ .status.conditions[?(@.type=="Ready")].reason ?? "Not ready" }}'
      detail: '{{ .status.conditions[?(@.type=="Ready")].message }}'

  # Facts in the detail panel's Details section.
  details:
    - { name: Issuer, path: .spec.issuerRef.name }
    - { name: Renews, path: .status.renewalTime, type: date }

  # Related objects, opened from the detail panel.
  links:
    - name: Secret
      kind: Secret
      objectName: '{{ .spec.secretName }}'
    - name: Issuer
      kind: '{{ .spec.issuerRef.kind ?? "Issuer" }}.cert-manager.io'
      objectName: '{{ .spec.issuerRef.name }}'
```

## Paths

Paths are the part of kubectl's JSONPath that CRD printer columns use, starting with a dot:

| Path                                            | Finds                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| `.spec.secretName`                              | a field                                                                    |
| `.metadata.labels['app.kubernetes.io/name']`    | a key with dots or slashes (or `labels.app\.kubernetes\.io/name`)          |
| `.spec.containers[0].image`, `[-1]`             | an item of a list, counting from the end when negative                     |
| `.spec.hosts[*]`, `.metadata.labels.*`          | every item of a list, or every value of a map                              |
| `.status.conditions[?(@.type=="Ready")].status` | items that match: `==` or `!=` a string, number, `true`, `false` or `null` |
| `.spec.parts[?(@.spare)]`                       | items where a field is set (and not false)                                 |

A path can also be written `{.spec.x}` or `$.spec.x`. When a path finds several values,
they're shown joined with commas.

## Columns and details

| Field     |                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | the column's header, or the fact's name                                                                                                                                                                                       |
| `path`    | where its value is                                                                                                                                                                                                            |
| `type`    | `string` (the default), `number` (right-aligned, sorted as numbers), `date` (shown as "in 30d" or "2h ago", sorted by time), `boolean` (Yes or No), or `count` (how many values the path finds, or how many items a list has) |
| `default` | what to show when the path finds nothing                                                                                                                                                                                      |

## Status rules

| Field    |                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `when`   | a condition (below); a rule without one always applies                                                      |
| `health` | `healthy`, `progressing`, `warning`, `critical` or `neutral`: the color, icon and filter it's counted under |
| `label`  | the status, a template                                                                                      |
| `detail` | more about it, shown on hover; a template                                                                   |

Conditions read one value at `path` and compare it:

```yaml
when: { path: .status.phase, equals: Running } # or notEquals
when: { path: .status.phase, in: [Failed, Error] }
when: { path: .status.message, matches: 'timeout|refused' } # a regular expression, ignoring case
when: { path: .spec.suspend, exists: true } # or false
when: { path: .spec.suspend } # set, and not false, 0 or empty
```

Comparisons ignore case, so `equals: True` matches Kubernetes' `"True"` though YAML reads it
as a boolean. Conditions combine with `all` and `any`:

```yaml
when:
  all:
    - { path: .spec.suspend, notEquals: true }
    - any:
        - { path: .status.phase, equals: Running }
        - { path: .status.phase, equals: Succeeded }
```

## Templates

Labels, details, links, action texts and patches can include values from the object:
`{{ .path }}`, with a fallback for when it finds nothing, either text or another path:
`{{ .spec.target.name ?? .metadata.name }}`, `{{ .spec.issuerRef.kind ?? "Issuer" }}`.
In patches, `{{ now }}` is the current time (as Kubernetes writes times).

## Links

| Field        |                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | what the object is to this one                                                                                                          |
| `kind`       | how KubeStacks names its kind: a built-in kind (`Secret`, `Pod`, `Node`…) or a kind and its API group (`ClusterIssuer.cert-manager.io`) |
| `objectName` | its name                                                                                                                                |
| `namespace`  | its namespace; this object's unless set (and none for cluster-wide kinds)                                                               |

A link whose kind or name comes out empty isn't shown.

## Actions

Actions patch the object, like `kubectl patch`:

```yaml
actions:
  - name: Reconcile
    icon: refresh-cw
    primary: true # a button in the detail panel, not only in its menu
    when: { path: .spec.suspend, notEquals: true } # only offered when this holds
    patch:
      metadata:
        annotations: { reconcile.fluxcd.io/requestedAt: '{{ now }}' }
    done: Asked Flux to reconcile {{ .metadata.name }} # the notification

  - name: Suspend
    patch: { spec: { suspend: true } }
    undo: { spec: { suspend: null } } # offered as Undo in the notification
    done: Suspended {{ .metadata.name }}

  - name: Abort
    danger: true
    confirm: The rollout stops and traffic goes back to the stable version. # asks first
    subresource: status # patches the status subresource
    patch: { status: { abort: true } }
```

| Field                               |                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `patch`                             | a merge patch (an object), or, with `type: json`, a list of JSON patch operations |
| `type`                              | `merge` (the default) or `json`                                                   |
| `subresource`                       | `status` to patch the object's status                                             |
| `undo`                              | a patch that takes it back, offered as Undo                                       |
| `confirm`                           | asks first, with this text; without it, the action runs at once                   |
| `done`                              | the notification once it's done                                                   |
| `when`, `primary`, `danger`, `icon` | when it's offered, whether it's a button, whether it's destructive, and its icon  |

Your account needs `patch` on the kind (or on its status) for an action to be enabled.

## Icons

`activity`, `archive`, `bell`, `box`, `boxes`, `cloud`, `database`, `gauge`, `git-branch`,
`globe`, `key-round`, `layers`, `lock`, `network`, `package`, `puzzle`, `radar`,
`refresh-cw`, `rocket`, `route`, `server`, `shield-check`, `timer`, `workflow`
([Lucide](https://lucide.dev/icons)).

## Contributing a view

A view for a popular project is a welcome pull request. Add it to
[src/renderer/src/views](../src/renderer/src/views), one file per project, with a comment
linking to the project. Give its kinds the few columns people look at first, status rules
when the conventions aren't enough, and actions that its own CLI offers (and that a patch
can do). KubeStacks checks every view it ships when it starts, and the tests fail if one
has a problem.
