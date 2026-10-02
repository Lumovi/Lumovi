# KubeStacks in your cluster

KubeStacks also runs in a cluster, as a dashboard for that cluster. It's the same app as the
desktop one, in a browser: people open its address, sign in, and see and change what their
own Kubernetes permissions allow. Nobody installs anything, and links to any page (a pod,
its logs, a release) can be shared.

## Install it

With [Helm](https://helm.sh):

```sh
helm install kubestacks oci://ghcr.io/kubestacks/charts/kubestacks \
  --namespace kubestacks --create-namespace
kubectl port-forward --namespace kubestacks service/kubestacks 8080:80
```

and open <http://localhost:8080>. To give it an address of its own, turn on the chart's
ingress (or put your own in front of the `kubestacks` service):

```yaml
ingress:
  enabled: true
  className: nginx
  hosts: [kubestacks.example.com]
  tls:
    - secretName: kubestacks-tls
      hosts: [kubestacks.example.com]
  annotations:
    # Pages keep a WebSocket open: don't let the ingress close it after a minute.
    nginx.ingress.kubernetes.io/proxy-read-timeout: '3600'
    nginx.ingress.kubernetes.io/proxy-send-timeout: '3600'
url: https://kubestacks.example.com
clusterName: production
```

The image is `ghcr.io/kubestacks/kubestacks`, for `linux/amd64` and `linux/arm64`. It has
Node.js, helm and KubeStacks, runs as a non-root user without a shell, and only writes to
`/tmp`. Each release is signed with a build provenance attestation:
`gh attestation verify oci://ghcr.io/kubestacks/kubestacks:VERSION --repo KubeStacks/KubeStacks`.

## Signing in

KubeStacks never gives anyone more than their own permissions. How it learns who someone
is depends on `auth.mode`.

### With a token (the default)

People paste a bearer token the cluster accepts, and KubeStacks sends their requests with
it: the cluster checks it, and applies its RBAC. KubeStacks' own service account needs no
permissions at all.

A service account's token, valid for an hour:

```sh
kubectl create serviceaccount alice --namespace kubestacks
kubectl create clusterrolebinding alice-view --clusterrole view \
  --serviceaccount kubestacks:alice
kubectl create token alice --namespace kubestacks
```

When the token expires, or is revoked, the session ends and KubeStacks asks for another.
Tokens from your identity provider work too, if the API server accepts them (its
`--oidc-*` flags, or a structured authentication configuration).

### With single sign-on

People sign in with an OpenID Connect provider: Dex, Keycloak, Okta, Entra ID, Google,
GitLab, and so on. KubeStacks then acts as them, with its service account impersonating
their user name and groups, so their RBAC applies.

Register KubeStacks with the provider as a web application whose redirect URI is
`https://kubestacks.example.com/auth/callback` (your `url`, then `auth/callback` below
`basePath`), and:

```yaml
url: https://kubestacks.example.com
auth:
  mode: oidc
  oidc:
    issuer: https://dex.example.com
    clientId: kubestacks
    existingSecret: kubestacks-oidc # a Secret with the client's secret under client-secret
    scopes: openid email profile groups
    providerName: Dex
  # Like the API server's --oidc-username-prefix and --oidc-groups-prefix.
  usernamePrefix: 'oidc:'
  groupsPrefix: 'oidc:'
```

People are named by the ID token's `email` claim (`auth.oidc.usernameClaim`), and their
groups come from its `groups` claim (`auth.oidc.groupsClaim`): bind roles to those names.
With the prefixes above:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: platform-team
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: edit }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: 'oidc:platform' }
```

#### When the API server trusts the provider itself

If the API server already accepts the provider's tokens (its `--oidc-*` flags, a
structured authentication configuration, an
[EKS OIDC identity provider](https://docs.aws.amazon.com/eks/latest/userguide/authenticate-oidc-identity-provider.html)…),
KubeStacks can pass each person's own token on instead of impersonating them. Its service
account then needs no permissions at all (the chart doesn't give it any), and the cluster's
audit log names the person directly.

```yaml
auth:
  mode: oidc
  oidc:
    # …as above, and:
    forwardToken: id # or access, for a provider whose access tokens the cluster takes
    scopes: openid email profile groups offline_access
```

KubeStacks renews tokens a minute before they expire, with the refresh tokens the provider
gives it (most need `offline_access` among the scopes for that). Without one, the session
ends when the cluster stops taking the token, and people sign in again. The token is a JWT
the cluster checks itself, so names and groups come from the API server's own settings (and
prefixes), not KubeStacks'.

### Behind an authenticating proxy

An authenticating proxy, like [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/)
or [Pomerium](https://www.pomerium.com), signs people in and names them in request
headers; KubeStacks acts as whoever they name. It trusts those headers completely, so
nothing but the proxy may reach it:

```yaml
auth:
  mode: proxy
  proxy:
    userHeader: X-Forwarded-Email # oauth2-proxy with --pass-user-headers
    groupsHeader: X-Forwarded-Groups # comma-separated
    signOutUrl: https://kubestacks.example.com/oauth2/sign_out
networkPolicy:
  enabled: true
  from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: oauth2-proxy
```

### What to keep in mind

- With a proxy, or single sign-on that doesn't pass people's own tokens on, KubeStacks'
  service account may impersonate anyone. Keep it in a namespace only cluster
  administrators can exec into, and use prefixes, so no group from a provider is one of
  yours by accident. KubeStacks never acts as Kubernetes' own users or groups
  (`system:…`), whatever a provider or proxy says.
- Sessions live in KubeStacks' memory: restarting it (an upgrade, say) signs everyone out.
  With single sign-on, signing in again is a click. For the same reason the chart runs one
  replica.
- `readOnly: true` keeps everyone from changing anything through KubeStacks, whatever their
  permissions. Each person can also make it read-only for themselves.

## What's different from the desktop app

- **One cluster**, the one it runs in. There's no cluster list to switch from.
- **No port forwarding**: there's no computer of the user's to forward a port to.
- **Charts come from repositories, registries or URLs**, never from files. KubeStacks
  fetches them only from public addresses unless `helm.allowPrivateCharts` allows private
  ones (a ChartMuseum or Harbor in your network): otherwise anyone signed in could make it
  reach services inside the cluster's network.
- **Preferences are each browser's**: the theme, which clusters you've made read-only, and
  where your usage history comes from.
- **Upgrading KubeStacks** is upgrading the chart.
- **Keyboard shortcuts** are the same, except ⌘N (Ctrl+N) and ⌘1…6, which browsers keep for
  themselves: the command palette (⌘K) has those commands.

## Views

Views everyone sees go in the chart's `views`, by file name (see [views.md](views.md)):

```yaml
views:
  team-certificates.yaml: |
    apiVersion: kubestacks.dev/v1alpha1
    kind: View
    metadata: { name: team-certificates }
    spec:
      kinds: [{ group: cert-manager.io, kind: Certificate }]
      columns: [{ name: Issuer, path: .spec.issuerRef.name }]
```

## Without Kubernetes

The image also runs on its own, showing a cluster from a kubeconfig: for a cluster a team
shares, say, from a machine of its own. KubeStacks uses the kubeconfig's credentials
(impersonating people, with single sign-on or a proxy), so give it a service account's.

```sh
docker run --rm -p 8080:8080 \
  -v "$PWD/kubeconfig:/kubeconfig:ro" -e KUBECONFIG=/kubeconfig \
  -e KUBESTACKS_CONTEXT=production \
  ghcr.io/kubestacks/kubestacks
```

## Configuration

The chart sets these for you; they're for running the image another way.

| Variable                                                 | What it does                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `KUBESTACKS_PORT`                                        | The port to listen on: 8080 unless set.                                                                                             |
| `KUBESTACKS_ADDRESS`                                     | The address to listen on: every interface unless set.                                                                               |
| `KUBESTACKS_URL`                                         | The address people open it at. Single sign-on needs it; with `https:`, cookies are HTTPS-only.                                      |
| `KUBESTACKS_BASE_PATH`                                   | Where it is below that address, like `/kubestacks`.                                                                                 |
| `KUBESTACKS_CLUSTER_NAME`                                | What it calls the cluster: `in-cluster` (or the kubeconfig's context) unless set.                                                   |
| `KUBECONFIG`, `KUBESTACKS_CONTEXT`                       | A kubeconfig, and its context, to show instead of the cluster it runs in.                                                           |
| `KUBESTACKS_AUTH`                                        | `token`, `oidc` or `proxy`.                                                                                                         |
| `KUBESTACKS_OIDC_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET` | The OpenID Connect provider, and KubeStacks' client there.                                                                          |
| `KUBESTACKS_OIDC_SCOPES`                                 | `openid email profile` unless set.                                                                                                  |
| `KUBESTACKS_OIDC_USERNAME_CLAIM`, `_GROUPS_CLAIM`        | The ID token's claims that name people and list their groups: `email` and `groups` unless set.                                      |
| `KUBESTACKS_OIDC_PROVIDER_NAME`                          | The provider's name on the sign-in button.                                                                                          |
| `KUBESTACKS_OIDC_FORWARD_TOKEN`                          | `id` or `access`: pass people's own token on (the API server must trust the provider) instead of impersonating them.                |
| `KUBESTACKS_PROXY_USER_HEADER`, `_GROUPS_HEADER`         | The headers a proxy names people and their groups in: `X-Forwarded-User` and `X-Forwarded-Groups` unless set.                       |
| `KUBESTACKS_PROXY_SIGN_OUT_URL`                          | Where signing out of the proxy is.                                                                                                  |
| `KUBESTACKS_USERNAME_PREFIX`, `KUBESTACKS_GROUPS_PREFIX` | Prefixed to impersonated users' and groups' names.                                                                                  |
| `KUBESTACKS_SESSION_HOURS`                               | How long sessions last: 12 hours unless set, at most a week.                                                                        |
| `KUBESTACKS_HEARTBEAT_SECONDS`                           | How often pages' connections are checked: 30 seconds unless set. Shorter than proxies' idle timeouts.                               |
| `KUBESTACKS_READ_ONLY`                                   | `true`: nobody changes anything through KubeStacks.                                                                                 |
| `KUBESTACKS_METRICS_SOURCE`                              | Where usage history comes from unless people choose: `auto`, `off`, or `namespace/service:port`, with a path after it for vmselect. |
| `KUBESTACKS_ALLOW_PRIVATE_CHARTS`                        | `true`: charts may come from private network addresses.                                                                             |
| `KUBESTACKS_ARTIFACT_HUB_URL`                            | Where to search for charts: `https://artifacthub.io` unless set.                                                                    |
| `KUBESTACKS_VIEWS_DIR`                                   | Where the views everyone sees are: `/etc/kubestacks/views` unless set.                                                              |
| `KUBESTACKS_HELM`                                        | The helm to run: the image's unless set.                                                                                            |

It answers `GET /healthz` (below the base path) for liveness and readiness probes.
