# Changelog

All notable changes to Lumovi are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

Entries wait in [`changelog.d/`](changelog.d), a file each, until a release gathers them here (`npm run changelog` prints them).

## [1.23.0] - 2026-10-21

1.23.0 has two security fixes, under Security below: every object's name and namespace is
checked before the cluster is asked, and an answer that isn't the object asked for is refused; and
on a server, people's groups follow the sign-in provider, and someone it disables is signed out.

It also adds a Search page, a Settings screen with keyboard shortcuts of your own, several
clusters in one list, a Map of the whole cluster, Helm repositories with a chart browser and
Update available, Compare with…, certificates in Secrets, quotas that show how full they are,
links to what you're looking at, tabs that move to a window of their own, and adding EKS clusters
from AWS. A plugin's file can withhold fields Lumovi then never shows, and a plugin's tables
download as CSV. It's built with Lumovi-plugins 1.5.2.

### Added

- **Move to a new window.** A tab below moves into a window of its own from its tab's menu: the
  tab alone, filling the window, under a band that names it, over the window it came from. A
  terminal's shell goes on running there, with what it showed; one that has ended stays below.
  A kept object on its Shell moves on its overview, since another window would start another
  shell. **Put back below** returns it to the window it came from, else to the one in front on its
  cluster; with no other window, its own becomes a window of Lumovi's pages with the tab below.
  Closing the window closes the tab, ending a terminal's shell. After a quit, it opens again where
  it was, a terminal ended and its shell started only when asked; one on a cluster that signs in
  through a program waits for **Read it now**.
- On Windows, a terminal whose PowerShell has shown nothing after 5 seconds says it's still
  starting, and that a profile or a virus scan can slow it down; the line gives way to PowerShell
  once it draws, and what was typed meanwhile still reaches it.
- Links to what you're looking at. **Copy link** in an object's More actions, and **Copy link to
  this view** in a page's menu, copy a `lumovi://` link. Where the same cluster is in someone's
  kubeconfig, under any name, it opens the same object or view in their desktop app. A link only
  shows: it never carries a credential, never opens a shell, an attach or a port forward, and
  changes nothing. Every link asks first, naming the cluster as your kubeconfig calls it, and one
  to a cluster you don't have says so, with Add a cluster. An organization can turn links off with
  the policy key `"links": "off"`.
- **Certificates in Secrets.** A Secret's panel shows what each certificate in it says: who it's
  for, the names it covers, its issuer, when it's valid, and its chain, flagged where it, or a
  certificate in its chain, has expired, isn't valid yet, or expires within 14 days; the flag is
  at the panel's top too. A bundle of roots is only counted, and the private key is never shown.
  The Secrets list has an Expires column, with chips for those not valid and those expiring soon.
  Where access shows a Secret's keys only, none of it shows.
- **Helm: wait, undo, timeout, and what a rollback changes.** Installing a chart and upgrading a
  release can wait until what Helm made is ready, undo it if it fails (an upgrade rolled back, an
  install uninstalled), and give Helm a timeout, each with Helm's own flag beside it; while it
  waits, the dialog says how long, and closing it doesn't stop Helm (quitting Lumovi asks first).
  Rolling back shows what it changes: the values by key, and the manifest's differences, with
  Secrets' values masked until revealed, as they are now in a release's Manifest tab and where
  its history compares manifests.
- **Fields a plugin withholds.** A view in a plugin's file can name fields of its own kinds that
  Lumovi never shows or hands on (`withholds`), like the line around a secret a scanner found.
  They're taken out before anything leaves Lumovi's backend: lists and their CSV, an object's YAML
  and its copy, its Map and Audit tabs, a plugin's code, and AI assistants' tools. The YAML tab
  says which fields are withheld, and whose file withholds them. Such an object isn't edited whole
  in Lumovi, nor patched where a change would touch them: use kubectl. Every plugin file Lumovi
  has counts, whether or not its plugin is shown or allowed, and while a file doesn't read, the
  custom kinds of its groups aren't shown at all, since it may withhold fields of them.
- **Compare with…**, in an object's More actions and the command palette, sets an object beside
  another of its kind, from another namespace or another cluster, and shows what differs, its
  status included. What the cluster sets itself (uids, versions, times, addresses) is left out
  until you ask for it. A workload's ConfigMaps and Secrets are compared with it, paired by where
  it refers to them. Each side is read with your own access on its cluster: Secrets' values stay
  masked until revealed, and where either side shows a Secret's keys only, only keys are compared.
  Nothing signs in by itself: a cluster that signs in through a program is read only when you open
  it.
- **Helm: repositories, a chart browser, and Update available.** The Helm page has tabs:
  Releases, Charts and Repositories. Repositories are added there (HTTP, or an OCI registry with
  the charts to look for), tested, edited and removed; Lumovi keeps them itself, not in Helm's own
  list, and reads them every 30 minutes and when the page opens. A sign-in is sent only over
  https, only to its repository, and is kept in the system's keychain on the desktop (none is kept
  without one) or sealed on a server, where only Lumovi's admins add repositories. Helm never sees
  it: Lumovi fetches the chart, checks it against the digest its repository lists, and hands Helm
  the file. Charts lists what's in them, with each chart's versions and Install. A release Lumovi
  installed from a repository, or whose chart matches the one repository that has it, says
  "Update available" when there's a newer version there, and Upgrade opens with it.
- **Several clusters in one list.** On the Clusters page, **Several clusters** puts a box on each
  row, and a group's **Open together** opens its clusters at once; on a server, the Fleet page
  offers the same. Their Workloads, Pods, Nodes and Events are listed together, with a Cluster
  column, each cluster read with your own access on it. One that doesn't answer within 10 seconds
  says so on its chip, with Retry, while the others are listed, and one whose refresh fails keeps
  its last rows and says so. An action, the panel and a new terminal are each on one cluster and
  name it, and rows ticked on two clusters aren't acted on together. A cluster that signs in
  through a program is read only when you open it. The clusters opened together last are offered
  again at the top of the Clusters page and in the command palette.
- **Quotas show how full they are.** Resource Quotas and Limit Ranges have lists of their own,
  under Configuration. A quota's row shows its fullest resource, with a meter and how full; its
  Overview, a meter for each resource it limits. From 90% it's Nearly full, and at its limit Full,
  each with an icon as well as a colour. A namespace's Overview lists its quotas and limit ranges,
  a quota from 90% is in Needs attention, and a Deployment whose pods a quota keeps from being made
  says so, with the quota to open.
- **A plugin's tables download as CSV**, as Lumovi's own lists do. **Download CSV**, in a table's
  heading or its card's (at the list bar's end where the table is its page's list), saves every
  row the table's filters leave, in its order, each column as a spreadsheet reads it, with the same
  guard against cells a spreadsheet would run as formulas. Lumovi writes the file from what it
  shows, so it never holds a field a plugin's file withholds, and the plugin doesn't learn it was
  saved.
- **Settings.** A Settings screen (the sidebar's gear or the palette; on the desktop, also ⌘,
  or Ctrl+, and the app menu's Settings…), each setting applied at once, in every window, and
  kept:
  theme and accent (Blue, Cyan, Violet, Graphite), density and text size (the View menu's zoom,
  one setting); the time zone and clock every date is said in; the terminal's font, size and
  copy on select, and on the desktop the shell it starts; and which namespace a cluster opens in.
  On a server they're kept per person, on every device they sign in from. What an organization
  sets (the desktop's policy file, a server's `LUMOVI_SETTINGS`) is shown locked.
- **Search the cluster.** A Search page (in the sidebar, ⌘⇧F or Ctrl+Shift+F, and from the palette)
  finds objects of the kinds you may list, by part of their name or by their labels (`app=web`,
  `tier!=db`, `team=*`, `!canary`), in the namespaces picked, grouped by kind, each with its status.
  Only names, namespaces, labels and ages are read, never what objects hold. A kind too large to
  read whole says how much was searched, and a label search asks it again for just those labels. The
  palette shows matching objects as you type. Searches can be saved, and the first nine run with ⌥⇧1
  to ⌥⇧9 (Ctrl+Shift on Windows, Alt+Shift on Linux).
- **Add a cluster from AWS.** Add a cluster has a third way in, From AWS. When you choose Find
  clusters, and only then, Lumovi runs your own `aws` CLI, as you, to list your profiles and the EKS
  clusters each one has in the regions you give. One you add signs in with `aws eks get-token` as
  its profile, a command you agree to first, and goes in a group named for its account and region.
  Lumovi reads nothing of `~/.aws` itself and keeps no credential.
- **Map, the whole cluster in one picture.** Where an object's Map tab shows how that one object
  is connected, Map under Workloads (or G then Y) draws everything in the namespaces picked: what
  routes traffic, the services, the workloads, their pods and the ConfigMaps, Secrets and claims
  they use, with lines between them, in a band per namespace, node or app. Each card says how it
  is in words, each band counts what's failing or warning, and Find dims what doesn't match. On a
  large cluster or a narrow window, a workload counts its pods and what's healthy folds away. It
  can also be shown as a list, which is what a phone shows.
- **Keyboard shortcuts in Settings.** You can change a command's keys, put one back or reset them
  all, and the menus, the palette, the ? sheet and tooltips show yours. Keys another command has
  are asked about before they're taken. The system's own keys, a terminal's and the keys built
  into lists are refused, with the reason. On a server they're kept per person. An organization
  can set a command's keys and lock that command (`settings.shortcuts` in the policy file, or
  `LUMOVI_SETTINGS` on a server).

### Fixed

- On the events timeline, a mark's card no longer shows another object's or another event's
  details after a zoom, or as rows and events come in before it: it stays with its own event, and
  a zoom lets it go.
- On the events timeline, a short bar's count no longer covers the mark after it. Where a mark
  follows too close, the count goes before the bar's first mark instead, or, with no room on either
  side, only its card says it.
- The Events page's List and Timeline switch is no longer cut off in a narrow window or beside a
  row's panel: the toolbar puts its chips on a second row first, and the filter keeps room to type
  in.
- A plugin's list beside a row's panel keeps its filter clear of its chips: where they don't fit
  beside it, the chips take a row of their own under it, as in Lumovi's own lists, and its filter
  says "Filter" alone where the bar is narrow.
- A plugin's table keeps each status whole: beside a row's panel, its other columns give way
  before a status is cut, and pointing anywhere on a row says its cut cells whole, as the keyboard
  does.
- A plugin's change dialog draws its switches as Lumovi's own, so one that's off no longer looks
  on: Argo CD's Sync showed Prune, Dry run and Apply only as on while they were off.
- Lists no longer scroll sideways, at any window width, with the panel open or not. Where there's
  no room, the least important columns give way first; then a status narrows to its icon, in its
  colour, with its word in a tooltip; then the other columns give way; and last the name narrows,
  cut in the middle so the pods of one ReplicaSet stay told apart. In Events, Message stays, Type
  narrows to its icon, and Reason gives way. Headings no longer show the rows scrolling under them,
  and a page's address sorted by a column the list doesn't have, or can't sort by, drops that
  order. The bar over a list keeps to its pane too: where it's narrow, beside the panel say, a
  page's own button, such as Install chart, narrows to its icon, with its name in a tooltip, and
  then the count moves to the line under, before the chips. A plugin's page header puts its
  buttons under its status where they don't fit beside it.
- **The AI assistants page lists only the assistants connected now.** One that disconnected as the
  page opened, or while it was asking how things stood, could stay listed until something else
  changed. Your AI permissions, a server's assistants and the port forwards list keep up the same
  way.
- **Microsoft Entra ID: someone in more than 200 groups signs in with their groups.** Their ID
  token then lists none, only that there are too many to list: Lumovi reads them from Microsoft
  Graph, as them, with User.Read (add it to `LUMOVI_OIDC_SCOPES`), at sign-in and at each renewal.
  Those are the security groups they're in; Microsoft 365 groups don't come through. Where Graph
  can't be read, they sign in with no groups, and the Account menu says so. A national cloud's
  Graph is set with `LUMOVI_OIDC_GRAPH_URL`.
- **Adding a cluster to a fleet says what's wrong.** Where it said "The server doesn't answer", it
  names the problem, with what to do: a client certificate or key that isn't one, or a server
  certificate that's for another name (with the names it gives), isn't signed by the CA given, has
  expired or isn't valid yet. "The server doesn't answer" is left for a server that can't be reached
  in time. Removing a cluster that isn't there, a name that isn't text and an empty group get plain
  answers too.
- **A kubeconfig user that signs in with `auth-provider: oidc` stays signed in.** Once its ID
  token had expired, Lumovi couldn't get credentials for the cluster. Now it renews the token from
  the issuer with the refresh token, as kubectl does. In the desktop app, it writes the new tokens
  back to the kubeconfig the user came from, as kubectl writes them, under kubectl's lock. Only
  that user's `id-token` and `refresh-token` change, and comments and everything else stay as they
  were. Where the file can't be written, Lumovi keeps the tokens until it quits, and says so. When
  a renewal fails, the cluster says why Lumovi couldn't sign in. A server keeps renewed tokens in
  memory only and never writes its kubeconfig.
- **No view breaks on an object that leaves out a field the API doesn't require.** An autoscaler
  without metrics, an event about no object in particular, a node that hasn't reported yet or a
  service without a selector could stop its list, its detail or its Map tab with "couldn't be
  displayed", or the whole window with "Something went wrong". Lists, details, maps, the Overview
  and the actions now cope with whatever the API leaves optional.
- **A dialog that closes leaves the keyboard where you put it.** One that went a moment after you'd
  moved on, into a list's filter say, gave the keyboard back to what had opened it, so what you
  typed next went there instead. Now it gives the keyboard back only if it's still in the dialog.
- **A link's Add a cluster opens Add a cluster.** On the card for a link to a cluster Lumovi
  doesn't know, Add a cluster could land on the start screen without its dialog, when the start
  screen hadn't yet read the kubeconfig files. Now it opens as soon as it may.
- **The Overview draws for an account that may read less.** One that may not list nodes, as
  Kubernetes' own `view` role can't, saw the whole Overview fail with "nodes is forbidden". Now the
  rest of the page draws, and the node parts (Nodes ready, CPU, Memory and Nodes) say the account
  isn't allowed to list nodes. Where node metrics can't be read, because the account may not read
  them or the read fails, CPU and Memory no longer stay "Measuring…": they show what's requested
  and say why there's no live usage. With only one cluster, an Overview that fails no longer offers
  "Choose another cluster".
- How long something has run reads in days past a day: "15d 17h", not "377h 53m", in a status's
  count, a busy button and its menus, and "15 days 17 hours" to a screen reader.
- A row of tabs, like an object's, no longer runs past its edge, where a pod's YAML was cut to "YA"
  at 1024 wide. The tabs that fit stay in their order, and the rest are in More at the row's end, a
  menu (a sheet on a phone). The open tab always has a place in the row. From the keyboard, More is
  the row's last stop: → past the last tab, or End, then ↓, Enter or Space opens it.

### Security

- **Single sign-on: groups follow the provider, and someone it disables is signed out.** Given a
  refresh token (offline_access, for most providers), Lumovi now keeps it, sealed, whether or not
  it passes people's own tokens on, asks the provider again before each ID token expires, and
  revokes it at sign-out where the provider can. Someone's groups are then as the provider says
  now, from their next request. A provider that won't renew a sign-in (the person was disabled or
  removed) ends the session at once; one that renews it without a new ID token doesn't say their
  groups again, so the session ends when the last ID token expires; one that can't be reached is
  asked again, and the session ends when the token it last gave expires. A change to someone's
  groups is in the audit log.
- **A name that isn't one could reach more than one object, or another one.** Asked for an object
  by a name like "." or "..", which no object can have, or for a pod by a name with a backslash,
  Lumovi could send the cluster an address that reaches more than that object, or something else.

  - **Reads, on a server (1.6.0 to 1.22.1).** A read of one object could bring back every object of
    its kind in the namespace, handed back as if it were the one. Where your
    [access](https://docs.lumovi.dev/server/access) shows someone only a Secret's keys, the Secrets
    in that list came with their values.
  - **Shells, attaching and file copies, on a server (1.6.0 to 1.22.1).** A pod's name with a
    backslash could open a shell in a container, attach to one, or copy files to or from one, in
    another namespace than the one Lumovi's access checked.
  - **Deletes, on the desktop and on a server.** A delete by such a name could delete every object
    of its kind in the namespace (or, for a kind outside namespaces, like nodes, every one), or the
    namespace itself. Lumovi's own pages never asked for such a name: it took an assistant's delete
    or a plugin's proposed change, approved in a dialog that named "." or "..".

  Each went to the cluster as the person signed in, so never past what the cluster lets them do.
  What they got past were Lumovi's own rules: where someone sees only a Secret's keys, and where
  they may open shells. The reads and deletes have been seen against a test cluster, not yet
  against a real API server.

  Lumovi now refuses a name or namespace Kubernetes wouldn't accept, holds a pod's, a node's and a
  Service's name to Kubernetes' stricter rule, never sends an address that steps with "." or ".."
  or reads differently from what was written, and refuses an answer that isn't the object it asked
  for.

  The [audit log](https://docs.lumovi.dev/audit/overview) recorded each of these by what was asked,
  like "Read Secret .", never by what it reached. Where a read was by someone shown only keys,
  change the values of the Secrets in that namespace. Where a shell, attach or copy was on a pod
  whose name has a backslash, it went to another namespace.

## [1.22.1] - 2026-10-15

1.22.1 makes the pages Lumovi's plugins draw look and work like Lumovi's own: a page that is one
list, such as Argo CD's Applications, is drawn as Lumovi's lists are, with their count, chips,
filter and pages of rows, and every plugin's page is framed as Lumovi's are, named in the bar for
the page that's open. A plugin's page no longer has a line of its own saying whose it is: the bar's
**More** (⋯) says that, under **What Argo CD may do** for Argo CD's, with what it may read and
change.

It also fixes CloudNativePG's Backup health, which Lumovi stopped as it opened, and Prometheus
Operator's Target health, which showed tiles about targets it never read, and it keeps "Comes with
Lumovi" whole on a narrow Plugins page. It's built with Lumovi-plugins 1.4.3.

### Changed

- Argo CD's **Applications** shows an application's project under its name, with where it's from,
  as Lumovi's lists show a namespace (Lumovi-plugins 1.4.3).
- A plugin's page that is one list, such as Argo CD's Applications, is drawn as Lumovi's own
  lists are: its count and level chips, the filter field, the headings and rows across the page,
  and its pages of rows. Its other filters are under More filters.
- A plugin's page is framed as Lumovi's own pages are: no line above it, tabs of words alone, the
  page's gutter, and the bar named after the page that's open. What a plugin may do is in the bar's
  new More (⋯), beside Keyboard shortcuts, and in the palette's Actions. A page's header that
  repeats its tab's title, or a tab's that repeats its object's name, doesn't say it again.
- A plugin's page, tab or command can't be called by one of Lumovi's own pages, lists or commands,
  nor as though it said what the plugin may do (with "permissions", "may do", "can do", "may read"
  or "may change" in its name): the file isn't used, and its problem says why. "Overview" is still
  a plugin's to use.

### Fixed

- **The Plugins page** no longer cuts "Comes with Lumovi" mid-word in a narrow window while a
  newer version is shown.
- Prometheus Operator's Target health draws no tiles about targets it never read: none until a
  namespace's Prometheus server answers, "from 1 of 2 namespaces" where only some were read, and
  Up green only where a target is up (Lumovi-plugins 1.4.3).
- CloudNativePG's **Backup health** draws, and its tiles count as the table under them shows. Lumovi
  stopped it as it opened, since two of its tiles named icons Lumovi doesn't have (Lumovi-plugins
  1.4.3).

## [1.22.0] - 2026-10-15

Add-ons are now **plugins**: a page lists them all, the desktop app installs and updates them from
Lumovi-plugins, and Argo CD's, CloudNativePG's, Karpenter's and Prometheus Operator's draw pages of
their own. A server's web UI works on a phone.

Lists choose their columns and update as the cluster changes, the namespace picker picks several,
objects can be pinned and views saved, and Create has a form beside its YAML. Events have a
timeline, alerts a page of their own, and logs a full search; Lumovi can tell you of new warnings,
and attach to a container's main process.

The desktop app opens more than one window, keeps objects open below the pages, opens again as it
was, and notices your kubeconfig changing. Nothing signs in by itself as it starts.

### Added

- A server's web UI works on a phone and a tablet. Under 1024 px wide the sidebar is a drawer
  behind a menu button, with the cluster and the namespace as two chips under the top bar. Under
  640 px a list is two lines an object (its name, cut in the middle so replicas stay apart, and
  its status; then its kind's first facts and its age), sorted and filtered from sheets; a detail
  is a page of its own with Back, its facts stacked and its tables as cards; logs wrap, with what
  runs over set in; and every menu, picker and dialog is a sheet from the bottom, an assistant's
  change to approve among them, with Reject and Approve at its two edges. Such a change arrives
  as the pill that says it waits, and its sheet opens when that's tapped; for a moment after the
  sheet opens, or moves on to the next change, Approve can't be pressed, so a tap meant for
  something else approves nothing. Dragging that sheet down or tapping outside it puts the
  change aside: it isn't an answer. On a phone an object
  offers Restart, Scale, Cordon and Uncordon, each behind its usual confirmation, and nothing
  else: no deleting, editing or shells there. Wherever the page is used by touch, what's pressed
  answers on at least 44 px and nothing needs a hover. A table's rows are cards there, and a
  card's facts stand side by side only where every value fits: a long one has a line of its own.
  Nothing scrolls sideways but a strip of tabs. The desktop app, whose window stops at 1024 px,
  is unchanged.
- Service accounts, roles and bindings have pages of their own, under **Access control** in the
  sidebar: Roles, Cluster Roles, Role Bindings, Cluster Role Bindings and Service Accounts, each
  also in the command palette and `g` navigation (`g r`, `g k`, `g b`, `g g`, `g t`). A role's
  rules read as a table of API groups, resources and verbs. The links go both ways: a binding
  links its role and its subjects, a role lists the bindings that grant it and to whom, a
  service account lists the bindings that name it and the role each grants, and a workload and
  its pods link the service account they act as. Someone who may not list one of these kinds
  is told so, on its page and in the panels that would have listed it.
- Create has a form beside its YAML. **Create…** (the + button, ⌘N, the palette) opens on
  **Form | YAML**. The form asks the essentials of nine kinds: a Deployment, a StatefulSet (its
  headless Service, and storage for each pod), a DaemonSet, a Job, a CronJob (its schedule read
  back in words), a Service (its type, the labels of the pods it sends to with how many match
  now, its ports), a ConfigMap (values of several lines), a Secret and a PersistentVolumeClaim.
  The YAML it writes is beside it: either side is edited and the other follows, and the YAML is
  what's created. Each field names the path it writes and lights its lines while it has the
  focus. What's wrong is said under its field as it's typed, with its lines marked, and what
  the cluster refuses is said under the field it names. What the YAML sets that the form has no
  field for (a strategy, a node selector) is kept as it is and named; YAML the form can't show
  (two containers, several objects, another kind) is still what's created: the form steps back,
  says why, and one button goes back to its last version. A form edit changes only its own
  characters: comments, the order of keys and their quoting stay as they were written. A
  Secret's values are hidden on both sides until **Show values** is chosen: while they're
  hidden the YAML shown holds none of them (nor the words of comments among them, where an old
  value is often left) and is read-only, a value is typed blind, and what the cluster says of
  it is kept back until they're shown. YAML whose values can't be told from the rest (it
  doesn't parse, or a value comes through an alias or a merge key) can't be hidden, and says
  so. YAML's side is the dialog as it was, and the side used last opens first.
- **Plugins** has a page of every plugin, last in its section of the sidebar (All plugins): the
  ones Lumovi comes with and your own files, each with its version, whether this cluster has
  it, and where it came from. Opened, a plugin says what it asks for, read from its file: the
  kinds it may change and create, what it reads, and each of its actions with what it sends (and what its undo sends) and
  whether it asks first or runs at once. A file that isn't in use says why there, and the API
  resources page points to it.
- **The namespace picker picks several namespaces.** ⌘↵ (Ctrl+↵ on Windows and Linux) adds one and
  keeps the menu open; ↵ picks one alone. Lists, Workloads, Events, Metrics and Helm releases
  show the picked namespaces together, up to 20, and the address carries them, so a link opens on
  the same ones. A namespace you can't list can be typed and picked like any other.
- **Lists choose their columns.** The Columns button at the end of a list's toolbar, or a heading's
  right-click menu, shows and hides columns, moves them (drag, or ⌥↑ ⌥↓) and adds one from a label
  or an annotation the listed objects carry. Drag a heading's edge to size its column (⌥← ⌥→;
  double-click for its own width again). A list never scrolls sideways: columns that don't fit
  aren't drawn, and the button says how many. What you choose is kept for that kind in that
  cluster. **Copy**, in the bar of picked rows (or ⌘C), copies them as the list shows them;
  **Download CSV** saves every row the filters let through, with whole values, times in UTC and
  numbers without units.
- **A plugin can say what its objects manage**: a view's `manages` names the labels and
  annotations its objects mark workloads with. Where one does, workloads' lists get a
  **Managed by** column (a fact on a phone's card), and a workload's Overview a line for each
  manager, with its plugin's icon, that opens it. To find them, Lumovi lists those views' kinds
  in the whole cluster where you may list them (else in the namespaces you're looking at), and
  the Plugins page says so. Where no plugin asks, nothing more is read.
- **YAML is checked against the cluster's schema as it's typed**, in **Create…** (its YAML and
  the form's) and when an object's YAML tab edits it. What the cluster would refuse (YAML it
  can't read, a value of the wrong type or not among those allowed, a required field left out)
  is marked as an error. What it would drop without saying so (a field the kind doesn't have,
  with the one meant where one is close) is marked as a warning. A card under the pointer says
  what's wrong, a line under the editor counts the problems, F8 and ⇧F8 go from one to the next,
  and ⌥F8 lists them. Typing a key, ⌃Space or ⌥Esc offers the fields that fit there, required
  ones first, and after a colon the values a field allows. Pointing at a field, or ⌥F1, shows
  what the schema says of it (⌥ is Alt on Windows and Linux). A custom resource is checked by
  its CRD's schema; where the cluster publishes none, only the YAML itself is checked, and a line
  says so. Nothing here stops a save: the cluster checks the YAML before anything changes. In
  YAML, viewed or edited, a character that can't be seen or would turn a line round shows as a
  placeholder, never as itself.
- **Pins and saved views.** Pin an object from its page (**Pin**, or ⌥P), from a list's row or
  from the command palette, up to 20 in a cluster. It stands in the sidebar under its cluster,
  with its status, and ⌥1 to ⌥9 open the first nine (⌥ is Alt on Windows and Linux; a browser on
  Linux keeps Alt and a number for its own tabs, so there they open from the sidebar or the
  palette). A pin whose object is gone, or can't be read, says so. Pins are moved and unpinned in
  the sidebar and the palette, with Undo. A list's columns, sort, filters and namespaces are saved
  as a named view, up to 20 for one kind and 50 in a cluster, opened again from the list's
  **Views** menu or the palette, and renamed, moved or deleted there. On a phone, the menu's drawer
  holds the pins, each with a sheet to open or unpin it. The desktop app keeps them in its
  settings. A server keeps each person's with who's signed in, wherever Lumovi keeps its state (the
  chart's Secret, `LUMOVI_DATA_DIR`, or memory): up to 32 kB in one cluster and 96 kB in all, and
  400 kB for everyone. A person's are let go after 180 days without use, and when everyone's would
  pass 400 kB, those of clusters the server doesn't show now go first, the longest unread first.
  Everyone who signs in with the same token shares one set.
- **An organization's policy can hold plugins to what it allows**: none at all (`plugins: off`),
  only the ones that come with Lumovi (`bundled`), or only those it names (`pluginsAllowed`).
- **Argo CD's and CloudNativePG's plugins draw pages of their own**, from code that comes with
  Lumovi and runs in the same sealed box, reading only what each file says, as you. Argo CD: an
  **Overview** of what needs a look; every Application in one table, filtered and searched, with
  **Sync** and **Refresh** for the ones selected; and a tab on an Application with where its sync
  is, its resources down to their pods, its problems and **Roll back**. Its **Sync…** has every
  option Argo CD's own has, says in red what a sync would harm, and is busy while one runs, with
  **Terminate sync**. Its **Sync…**, **Refresh…** and **Delete…** are changes you confirm in
  Lumovi's own dialog, shown as the cluster would make them. Besides Argo CD's own kinds it reads
  ReplicaSets and Pods, never what they run, and the warning events of those that aren't well, each
  message cut where it could carry what only you may read. CloudNativePG: an **Overview** of every
  PostgreSQL cluster with its instances, backups, schedules and poolers, and a **Backup health**
  page; its **Back up now…** is confirmed the same way. A resource's row opens Lumovi's own list at
  that object.
- **Flux's and Argo CD's plugins say what their objects manage.** A workload that a Flux
  Kustomization or HelmRelease manages, by Flux's own labels, or that an Argo CD Application
  manages, by Argo CD's tracking annotation, says so in its list's **Managed by** column and on
  its Overview. Where Argo CD tracks by the `app.kubernetes.io/instance` label, it isn't
  recognised: any chart can set that label, so a plugin can't name it.
- **Karpenter's overview is drawn by the Karpenter plugin**, whose code comes with Lumovi and runs
  in a sealed box: it reads only what its file says, as you, and changes nothing in your cluster. On
  a server it runs only in a browser Lumovi has checked keeps it apart, and whatever stands in front
  of the server (an ingress that lists its paths, a sign-in proxy) must let that check through:
  everything under `box-check/`, without a sign-in of its own; wherever it doesn't run, Lumovi's own
  overview of Karpenter is shown. A plugin's code can be turned off: by you, with **Run its code**
  on the Plugins page; on a server, for everyone or for all but the plugins named
  (`LUMOVI_PLUGIN_CODE`, the chart's `pluginCode`); or by an organization's policy
  (`plugins: no-code`), which can also let no plugin's page propose a change or show what's in a
  Secret (`pluginProposals`, `pluginSecrets`: `off`).
- **The Plugins page says which plugins have a newer version.** When you open it, or press
  **Check now**, the desktop app looks at Lumovi-plugins' latest release, and takes it only if
  it's signed by that repository's release workflow, built from its tag's commit, no older than
  one it already took, and not expired. A plugin with a newer one says so, or which Lumovi it
  needs, and **Not here yet** lists the plugins this Lumovi doesn't have, with what each would
  ask. An organization's policy can turn it off (`pluginStore: off`; `plugins: bundled` or `off`
  do too).
- **Plugins can be installed and updated from Lumovi-plugins**, in the desktop app.
  **Install…** or **Update…** on the Plugins page first shows what the plugin may do, in
  Lumovi's words, what's new first and whether its code changed, and nothing changes until you
  agree. The release is checked again then, and the plugin's files every time Lumovi reads them:
  a copy that isn't what you agreed to isn't used. **Back to** returns to the version before,
  kept on your computer, or to the one that comes with Lumovi, and one Lumovi doesn't come with
  can be removed. Nothing updates by itself. An organization's policy can pin plugins by version
  (`pluginsAllowed: [argo-cd@1.2.0]`) or turn this off.
- **Developer mode** runs code from plugins of your own. With it on, at the foot of the Plugins
  page, a plugin that is a folder of its own in your plugins folder (`<name>/plugin.yaml` and
  `<name>/plugin.js`) draws its pages in Lumovi's sealed box, as Lumovi's own and installed ones
  do, once you've seen what it may do and agreed. New code asks again with one press; a file
  that asks for more asks again with what's new. Off, which is how it starts, a folder's code
  isn't read at all. An organization's policy can keep it off (`pluginDeveloperMode: off`, or
  `plugins` set to `bundled`, `off` or `no-code`), and then lets go of what was agreed.
- **CloudNativePG's Overview links to Lumovi's own places** for the cluster picked: **Shell into
  primary** and **Forward 5432** open the primary pod's Shell tab and its Port forward, each
  instance's row opens that pod's logs, and the primary's log is on the page. A link only says
  where to go: a shell or a forward still starts only when you start it there, and Lumovi reads
  the log itself, so the plugin's code never holds a line of it. An organization's policy can keep
  plugins from showing logs (`pluginLogs: off`).
- **Prometheus Operator's plugin has a Target health page**: what's up, down and not scraped yet,
  the targets that are down with their last error, and each Prometheus server's scrape pools. It's
  the first plugin to ask its tool's own server in the cluster: in each namespace with a
  Prometheus it asks the `prometheus-operated` Service for its active targets, through Lumovi and
  as you. What the server answers reaches the plugin's code: every active target, with the labels
  and annotations of the Services and Pods behind it, from every namespace that Prometheus
  watches. The Plugins page says so first, in red, each ask is in the history, and an
  organization's policy can turn it off (`pluginServers: off`). A Prometheus scrapes across
  namespaces: whoever may reach its server sees all its targets, and each card says so.
- **AI assistants find a cause in fewer steps.** `find_problems` says how a failing container's last
  run ended, with its last error lines, and warns of a workload whose image's tag can move under its
  data. `get_logs` searches by text or level and pages through a long log. Two new tools:
  `get_rollout_history`, each rollout's images and the digests its pods pulled, and
  `find_in_clusters`, where something is in every cluster at once. No answer is more than an
  assistant can take.
- Nodes have taints: add and remove them, with what each effect does, and a warning before a
  NoExecute taint evicts pods. Drain takes a grace period, a timeout, and whether to leave
  DaemonSet pods; a pod a PodDisruptionBudget holds is tried again, and its row says which budget
  and why.
- **Lumovi notices your kubeconfig changing.** A context your cloud's command-line tool adds appears
  within a second, without Reload. **Add a folder…** reads every kubeconfig in a folder and keeps up
  as files come and go. A folder's context whose credentials run a program, send a file or go to a
  server Lumovi can't verify asks first, as an added cluster's do, and Lumovi's terminals aren't
  handed a folder's kubeconfigs. A file caught half-written keeps the contexts it had until it reads
  again, and says so. Lumovi never writes to any of them. On a server, the fleet's kubeconfig file
  is read again when it changes.
- **Events as a timeline.** On the Events page and an object's Events tab, **List** | **Timeline**
  shows events where they fell in time: a row for each object (on an object's tab, each reason), a
  Normal event as a hollow circle and a Warning as a triangle, and one that repeated as a bar from
  its first time to its last, with how many times. It shows the last 15 minutes, the last hour, or
  every event kept, and dragging across it zooms in. Each mark says what happened when it's hovered
  or focused, and the keyboard moves through rows and marks. Kubernetes keeps events for about an
  hour unless its API server is set otherwise, and the timeline says so. On a phone, or where the
  page is too narrow, events stay a list.
- **More than one window.** File → New Window (⇧⌘N, Ctrl+Shift+N) opens another on the start
  screen, so two clusters can be open side by side. Each window has its own pages, and what it
  starts (a terminal, a pod's logs, a copy, a port forward) is its own: it goes on whatever the
  other windows do, and ends when its window closes. Lumovi's windows open again where they were
  on the screen.
- **Alerts**, a page of its own under Cluster, beside Events (`g z`, and in the palette): what the
  cluster's Prometheus is firing and has pending, read from the source the Metrics page uses,
  through the cluster as you, every 30 seconds while it's open. The worst come first, each with its
  severity, how long it has fired or when it fires if its condition holds, the object its labels
  name, as a link, and how long it has been active. They filter by the header's namespaces, by
  severity, by firing or pending, and by text. One opens beside the list with its summary,
  description, labels, rule and runbook. An alert of severity none, like Watchdog, never counts as
  firing. Whoever may reach Prometheus through the cluster sees every alert it holds. Where alerts
  fire, the Overview's Warnings tile says how many, with a link.
- **Log search** takes a regular expression, matches case, or shows the lines without a match,
  each a toggle in the search field (⌥R, ⌥C and ⌥X; Alt and the letter on Windows and Linux), and
  steps between matches with ↵ and ⇧↵. A search that runs too long is stopped and says so, and an
  expression that isn't one says why, leaving the lines as the last search did. **Since…** takes
  a time ago, like 90m, or a date and time; a span with more than 20,000 lines shows its last
  20,000 and says so. On a computer, a strip under the search shows the lines over time, and
  dragging across it picks a stretch. A download is what's shown, and its name ends in -filtered
  when that's only part of the log.
- **Notifications of new warnings**, off until you turn them on for a cluster: in its settings on
  the desktop, or on a server in the sidebar's cluster menu, for you alone, in your browser. While
  Lumovi runs (on a server, while one of its tabs is open), it checks the namespaces you watch every
  30 seconds, as you, and your system shows each new Warning event: its reason, object and message
  (cut where it could carry what only you may read), and the cluster. Each object and reason is
  shown once in 10 minutes, and several in one namespace at once come as one. Clicking one opens
  Lumovi at the object, or at the namespace's warnings. If signing in to a cluster fails, its
  notifications pause, saying so once, until you open the cluster and sign in again.
- **Keep open below.** **Keep open below**, in the detail panel or the palette, keeps an object
  open below the pages, beside the terminals, on the tab it was showing: a pod's logs keep coming
  and a Deployment's metrics keep moving while the pages above go elsewhere. It's read in its own
  cluster. It says when the object was deleted, and offers what ran it instead, or when its
  cluster can't be reached; its tab's menu opens it in the panel again. With focus below, ⌘W
  (Ctrl+Shift+W) closes the tab shown.
- **Opened again as it was.** Each window comes back on its page, with the panel's object and what
  it had below. One that was on a cluster that signs in through a program opens the start screen
  instead, and that cluster is read when you open it. A kept object reads again as if just opened,
  on its overview if it was on its Shell; one on a cluster that signs in through a program waits,
  "not read yet", until you pick its tab, choose **Read it now**, or open its cluster. A terminal
  comes back ended, its name, cluster and namespace kept, with Start a new shell. A window whose
  cluster has gone from the kubeconfig opens the start screen. Nothing signs in by itself as Lumovi
  starts: a cluster that signs in through a program is checked when you open it.
- **Attach to a container's main process**, as `kubectl attach -it` does: **Attach** in a pod's
  actions, or on its Shell tab beside Shell. What the process prints shows, and what you type goes
  to it, Ctrl+C included; closing the tab detaches and leaves it running. A container whose input closes after one
  session (`stdinOnce`) is sent nothing, since detaching would end it, and one that takes no input
  shows what it prints. It's in the audit history with its command, and it's allowed where shells
  are: by your access on a server, the cluster's RBAC (`pods/attach`), and not on a read-only
  cluster.

### Changed

- A note at the bottom of the window (that a change was made, say) stays while a mouse points at
  it, and no longer while a finger's last tap happens to be where it appeared: on a touch screen
  it now always leaves after its few seconds. On a phone it sits above the pill of changes that
  wait, and is never over an open sheet: it's a line at the sheet's top instead, which says when
  it's about another change than the one shown. Where that line is too long it takes a second
  line, then the object's name and then the cluster's are shortened in their middle, then a third:
  how it ends, which is where it happened, is never cut off. A sheet's own heading says its
  cluster whole too, over as many lines as it takes, and the title of one of Lumovi's own dialogs
  takes up to three lines there, as an assistant's request does: a name too long for them is
  shortened in its middle.
- "Create from YAML" is **Create…**: on the + button, in the command palette, in the shortcuts
  and in the app's menu (where it was "New from YAML…").
- A change to a Secret that fails (an edit, a delete, a create) is in the activity log as
  having failed, with why in a word, and without what the cluster said: the cluster can quote
  the Secret's values, and the audit log already kept none of it. The dialog that made the
  change still shows the cluster's words.
- A Lumovi server whose audit history another Lumovi has taken over (two on one volume, one of
  them held up for longer than its hold lasts) now stops, saying why as its last line, and ends as
  a failure. From the moment it finds out, it does nothing more that's asked of it, and says so.
  It used to go on serving with nothing of what was done through it kept in that history. Started
  again, it waits its turn for the history, or says who holds it.
- Add-ons are **plugins**, and a tool's file is one thing: a plugin, with its place in the
  sidebar and, inside it, a view for each kind it shows. The sidebar's section, the command
  palette and the API resources page say Plugins: that page counts them and names the plugin that
  shows each kind, and a plugin's own page is at `…/plugins/<name>`. Your own go in
  `~/.lumovi/plugins` (or the folder `LUMOVI_PLUGINS_DIR` names; a server's in
  `/etc/lumovi/plugins`, from the Helm chart's `plugins`), one `kind: Plugin` a file with its
  views under `views:`. A file is used whole or not at all, and everything wrong with it is
  listed, where a part of a file used to be dropped by itself; when that leaves one of Lumovi's
  plugins in use in place of yours, the page says so. The command palette's field says
  "Jump to a page…", so that "view" means one thing in Lumovi: a part of a plugin.
- A plugin's file says more about itself, and is checked harder. It starts
  `apiVersion: lumovi.dev/v1beta1` and names its `version`, the oldest Lumovi it works with
  (`needs.lumovi`) and the API groups its kinds are in (`groups`). A name is lowercase letters,
  digits and hyphens. An action that changes something without asking first
  says `runs: at-once`. Refused, each with its reason on the API resources page: a key Lumovi
  doesn't know, anywhere in the file; two views of one kind in a plugin; a second file with a
  name another has (the first is used); a patch that
  changes what's the cluster's to set (an object's owners, finalizers, name or namespace); a
  text that's too long or holds characters nobody can see; and a plugin that needs a newer
  Lumovi than this one.
- A plugin of your own is held as Lumovi's are. Its kinds are in its `groups`, none of them
  Kubernetes' own, and an action of it creates only the plugin's own kinds. A kind of
  Kubernetes' that Lumovi has no page for can be shown, and only shown (no actions), by a plugin
  that names it under `shows`. A kind is one plugin's: yours takes the place of one of Lumovi's
  under that plugin's name, and then all of it, which the API resources page says beside the
  count; anything else that shows a kind another plugin has is refused, and the page says
  which and what to do. Of two of yours that show one kind, the first by file name is used.
- **An object's Events tab** stays quick with thousands of events: past 200, only the events in
  view are drawn, and a filter above them finds one by its reason, its message or what reported
  it.
- A server's `LUMOVI_URL` names one host: a name of letters, digits, hyphens and dots, or an IP
  address. One with a `*`, a comma, or a user and password in it is refused when the server
  starts, with a line that says so. The security policy sent with a server's pages names that
  address exactly.
- A server acts for someone signed in only on requests that say they come from Lumovi's own page.
  Where their browser sends Sec-Fetch-Site as they sign in, every later request of that session must
  send it as same-origin; any other is refused, and changes nothing of the session. A browser that
  doesn't send it as they sign in isn't held to it. `LUMOVI_SEC_FETCH_SITE=off` (the chart's
  `auth.secFetchSite`) turns it off. Behind a sign-in proxy, `LUMOVI_PROXY_SEC_FETCH_SITE=on` (the
  chart's `auth.proxy.secFetchSite`) says the proxy passes the header through unchanged: every
  request is then held to it, and one without it is refused. Off, the default, plugins that run code
  aren't offered behind a proxy. A setting that should be an address and isn't is no longer repeated
  in its error.
- A file in a plugins folder that isn't UTF-8 text isn't read: the API resources page lists it by
  name, as `platform.yaml: It isn’t UTF-8 text.`
- **Lists and opened objects update as the cluster changes**: a pod starting, failing or going
  away shows in about a second, rather than at the next read every 5 seconds. Lumovi watches what
  a page shows while it's shown, so a list that isn't changing isn't read again and again (once a
  minute still, to be sure). Where a cluster refuses to be watched, and for Secrets on a server and
  a fleet's clusters reached through their agent, lists are read every few seconds as before.
- **Clusters that sign in through a program wait to be opened.** The start screen and the
  cluster switcher say "Signs in when opened" for them instead of checking them, which would
  start that program, a browser or a prompt, for clusters nobody picked. The AI assistants'
  Permissions tab counts their namespaces only once they're signed in, with **Count them** to sign
  in and count them now.

### Fixed

- Create said nothing, and did nothing, for YAML whose alias names no anchor set before it
  (`name: *n` above the `&n` it means). It now answers as for any YAML it can't read, with what's
  wrong.
- What you type while a terminal is still opening is no longer lost: it reaches the shell once
  it's open, in the order you typed it.
- On a phone, the tabs at the top of Workloads, Metrics and a plugin's page are big enough to tap.
- On Windows, at any zoom, a name with room for all of it is shown whole, not cut in its middle.
- On a phone, a failed refresh's notice shows its whole reason, on as many lines as it takes.
- An equivalent command breaks between its words, so a flag such as `--replicas=5` stays whole;
  only a word longer than the line is broken inside. On a phone, a change's lines keep their −
  and +, not only their colour.

## [1.21.0] - 2026-10-10

Files are copied out of a pod's container and into one, from the pod's own actions. And two Lumovi
servers that share a volume no longer end up both keeping the audit history there.

### Added

- Files are copied out of a pod's container and into one, from the pod's actions: **Download
  files…** takes a file or a folder by its path, and **Upload files…** puts a file or a folder
  in a folder there, as `kubectl cp` does (it runs `tar` in the container, and says so where
  there's none, with the `kubectl debug` command that reaches its files instead). Each shows the
  equivalent command and its progress, can be stopped, and stops by itself when nothing moves
  for a minute; a copy that ends early leaves nothing half-saved. The desktop app asks where to
  save in the system's dialog; a server's page gets a browser download (a folder as a `.tar`),
  streamed, with nothing kept on the server. Of what a container sends, only files and folders
  under the path asked for are kept: links, devices and pipes are left out and counted, and an
  entry that names anything else ends the copy. A download needs the access a shell does and
  works on read-only clusters, as it changes nothing; an upload also needs changes allowed, is
  refused where it's read-only, and asks for the pod's name on production clusters. Both are in
  the audit log, when a copy begins and how it ends (who, pod, container, path, size; never
  contents, a container's own words, or the names of files in a folder). One copy carries 2 GiB
  at most unless `LUMOVI_FILE_COPY_MAX_BYTES` (the Helm chart's `fileCopy.maxBytes`) or the
  organization's policy (`fileCopy`) says otherwise; `off` (`fileCopy.enabled: false`), or the
  policy, turns copying off, and a server doesn't start with a limit that isn't a whole number.
  It isn't offered to AI assistants.

### Fixed

- Two Lumovi servers sharing one volume no longer both end up keeping the audit history there
  when they start together, or when one reads the other's lock as it's renewed. The lock that
  decides which one keeps it was written in place, so it could be read half written, taken for
  abandoned, and the history taken over, after which both numbered events the same. The lock is
  now always whole, only one of any number starting together takes it, one that can't be read is
  waited for like any other, and a server that finds another has taken its history over stops
  writing to it and says so, on its output and on the Audit page. A lock nobody renews is told
  by watching it, not by comparing two computers' clocks, and two containers that share a
  hostname no longer take each other's. A server that can't read or renew its lock for as long as
  one holds (30 seconds) stops writing the history until it can again, and only if nobody wrote
  to the history meanwhile. A server started again after a crash waits up to 20 seconds on its
  own old lock before it serves. Checking a history that two servers did write now names that as
  a possible cause.
- The Metrics page no longer fails on a Prometheus that keeps each node's own network series, which
  name no pod: choosing Network in or Network out could replace the page with an error. Network
  usage now counts only pods' traffic, on the page and in a node's charts, and a series that doesn't
  say which pod, node or namespace it is about is left out instead of breaking the list.
- A list's bar keeps to one row beside an open object: its label selector and filter shrink
  instead of dropping to a second line, as the Services list's did beside the map. Where there's
  less room still, the label selector is a button that opens its field under it, and says what's
  applied; health chips stay whole and take a row of their own only when they don't fit. Lists,
  Workloads, add-ons and Helm releases share the one bar.
- The Map opens for an object beside a custom resource that owns both its pods and the Services
  that select them, as CloudNativePG's `Cluster` does: opening one of its Secrets from the
  Cluster's Map showed "Cannot read properties of undefined (reading 'sort')" in place of the
  Secret. Lines that led round in a circle (the Cluster owns the Service, the Service selects
  the Cluster's pods) left rows of the Map empty; now such a Service is above the Cluster, as
  a Deployment's is, and no row is empty whatever the lines.

## [1.20.0] - 2026-10-10

Every way to sponsor Lumovi leads to one place: its listing on GitHub Sponsors.

### Changed

- Help → Sponsor Lumovi…, the sidebar's card and the README's sponsor links all open
  [github.com/sponsors/Lumovi](https://github.com/sponsors/Lumovi), Lumovi's listing on GitHub
  Sponsors.

## [1.19.0] - 2026-10-10

A cluster without Prometheus can have its usage history all the same: Lumovi offers to install a
small metrics stack of its own, shows everything it makes before making it, and removes it
without a trace.

### Added

- Where a cluster has no Prometheus, Lumovi offers to install a small metrics stack, so the
  Metrics page, each object's charts and right-sizing have history: Prometheus and
  kube-state-metrics, from a chart Lumovi ships (prometheus-community's `prometheus`, pinned and
  checked against its SHA-256 before every use, so nothing is downloaded by Lumovi) and images
  pinned by digest. It collects only what Lumovi reads (CPU, memory and network use, restarts),
  with two read-only cluster roles that reach nodes, their kubelets' metrics and pods: no Secrets,
  no ConfigMaps. History is kept for 7 days on the node's disk, without a volume. Nothing is made
  before the review: what will run, the values, and a dry run on the API server showing every
  object. It's installed with helm into a namespace of its own (`lumovi-metrics`), which Lumovi
  marks as its own, and recorded in the audit log with a helm command that installs the same chart
  from its repository. Removing it, from the metrics source's settings, uninstalls the release and
  deletes the namespace, leaving nothing in the cluster; a namespace Lumovi didn't make is never
  taken or removed. Without the cluster's permission for all of it, Lumovi says what's missing and
  installs nothing, and an install that fails is undone. Not offered on a read-only cluster. An
  organization turns it off with `"metricsStack": false` in its policy; on a server, only Lumovi's
  admins install or remove it (nobody, where it names none), and `metrics.stack: false`
  (`LUMOVI_METRICS_STACK=off`) turns it off.

### Changed

- With a metrics source that has no samples yet (a Prometheus in its first minute), the Metrics
  page says where history comes from under "No data for this time", which is also the way to the
  source's settings.

### Fixed

- A cluster the Prometheus operator was uninstalled from no longer shows "Can't read usage
  history": the service the operator leaves behind for the kubelets isn't taken for Prometheus,
  so the cluster is said to have none.

## [1.18.0] - 2026-10-09

A fleet is run from its page: its admins connect a private cluster with an agent, add one from a
kubeconfig or a token where the chart allows it, and name, label and share each one. On Windows
and Linux, the desktop app's menu is a button away.

### Added

- On Windows and Linux, the desktop app's menu has a button in the window's top left corner, in
  every view, since its window has no menu bar: Help (Sponsor Lumovi, Check for Updates, Report an
  Issue), View (zoom, full screen, Match kubectl to Each Cluster) and the rest are reachable with
  the mouse. Alt on its own, or F10, opens it too.
- Help → Documentation opens docs.lumovi.dev, on every platform.
- A fleet's admins connect a private cluster from the Fleet page (Add cluster, then Connect with
  an agent…): its name, labels and groups, then one command to run with their own access to it,
  which installs its agent. The agent dials the hub, so the cluster opens no port and nobody
  pastes its credentials into the hub. The command's join token works once, for an hour, is
  shown once and never kept (only its SHA-256), and is read from the terminal, not the command
  line. The agent exchanges it for a token of its own, which it keeps in its Secret (the one
  Secret it may change), so the join token is no use once it's joined. The page waits for it
  with a timer and a card, then asks for its certificate authority to be checked: until it is,
  only admins see the cluster, as whoever first used the token is trusted. Making, cancelling,
  joining and removing are admin-only, need Lumovi's admins configured and its state kept, and
  are recorded in the audit log.
- A fleet's admins name, label and share each cluster from its card on the Fleet page (its ⋯,
  then Settings…): the name it's shown by, its labels, and its groups, who sees it besides
  admins, which applies at once. What a cluster's source sets (a Secret's `lumovi.dev/*`
  annotations or Argo CD's labels, a kubeconfig's `lumovi.dev` extension, `LUMOVI_CLUSTER_LABELS`,
  `LUMOVI_FLEET_AGENTS`) stays the source's: shown locked, with where to change it, never
  overridden. The page's settings are kept in Lumovi's own state, never in a Secret, and put back
  if an older copy is put back where they're kept. Each change is in the audit log, with who saw
  the cluster before and after. Only Lumovi's admins change them, and only where it has some;
  and admins now see every cluster, whichever groups it's shared with.
- Where its chart allows it (`fleet.addFromPage`, off unless set), a fleet's admins add a cluster
  on the Fleet page by pasting a kubeconfig, or a server, a token and its CA. It's checked first:
  it reads, it signs in with what's in it (a credential plugin is refused, as the hub runs no
  programs, and it offers a token or an agent instead), its server is https and checked against
  its CA, and its credentials work and may act as each person. It's kept as a Secret of Lumovi's
  in its own namespace, the only place the chart then lets Lumovi write Secrets; removed from the
  page, that Secret is deleted (never one Lumovi didn't make). Admin-only, and recorded.

### Changed

- The project's contact address is peter@lumovi.dev: in the Code of Conduct, the Linux and AUR
  packages' maintainer and the chart repository's Artifact Hub owner.

### Fixed

- A server keeps running when a WebSocket connection it refused (a page's that isn't signed in,
  or an agent's with a token it doesn't know) is then reset by the other end, which stopped it
  before.

## [1.17.0] - 2026-10-09

The desktop app has a clusters page: clusters added from a pasted kubeconfig, the kubeconfig files
it reads chosen there, and each cluster's own name, color, group and labels. Statuses look as the
brand's do, and dark mode's buttons are readable.

### Added

- The desktop app's clusters page is new. Each cluster is a tile in its color, with its status on
  its corner, its name and where it is, and its version and latency or what went wrong. The ones
  opened last come first, then Lumovi's groups (or a label's values, or none), and a search finds
  them by name, context, server or label (showing the label it found). Its actions are on its ⋯,
  on right-click or on `.`: its settings, the line for kubectl, its file in Finder, hiding it, or
  removing one added in Lumovi.
- The kubeconfig files the desktop app reads are chosen from the clusters page's footer: one in
  place of KUBECONFIG's (or ~/.kube/config), or more after them. Each says where it's from and how
  many clusters it has, or that it's gone or can't be read, and then the others still load, under
  a notice. Lumovi never writes them, and its terminals get the same files. An organization's
  policy can keep it to KUBECONFIG's or ~/.kube/config (`kubeconfigFiles: "locked"`).
- A cluster can be added from a pasted kubeconfig, or a file: checked first (it reads, its server
  answers, its credentials work), then kept in Lumovi's own folder (only you can read it), never
  in your kubeconfig. A credential that runs a program on your computer, or sends a file to the
  server, is shown exactly, and nothing runs or is sent until you allow it; so is sending its
  credentials to a server Lumovi can't verify, or unencrypted over http://. Once added, it's named,
  colored and grouped, with the line to use it with kubectl. Its connection can be edited (its
  secrets stay in Lumovi), and it can be removed.
- Each cluster's settings, kept in Lumovi (⌘I): its name, color, group and labels, the namespace
  it opens in, and whether it's production, read-only or hidden. Production, set by hand, wins
  over Lumovi's guess from its name, for its chip and the names typed to delete and drain. Its
  name shows in the switcher, the palette and the window's title too.

### Changed

- Statuses look as they do on the website and in the docs (the brand's): in progress is neutral,
  not blue, its dot pulsing and its icon turning once every 3 s (both still for people who ask
  for less motion); every status's mark reaches 3:1 and its words 4.5:1 on each surface, in
  light and dark, with pills filled with their mark at 12%; and the orange of "serious" is gone,
  YAML's numbers and booleans included. One word has one look: a job still running says "In
  progress" (a pod's Running is healthy). Blue is for what can be acted on: links and text buttons
  use the stronger blue, which reads at 4.5:1 on every surface, the lighter one is for icons, and
  Access's notes of what's to know and a live terminal's tab are neutral.
- In dark mode, primary buttons are the same blue as in light (white on it is 4.6:1, as button
  text needs, not 3.6:1), and a primary or danger button hovered turns deeper, not lighter.

### Fixed

- A link that sorts a list by a column that doesn't sort (`?sort=ready`), or one the list doesn't
  have, shows the list in its usual order instead of failing.
- "Copy kubectl describe" and "Copy kubectl logs" in a row's menu name the cluster (`--context`)
  and a custom kind's API group, as the dialogs' commands do, so they run against the right one
  wherever they're pasted.
- The Workloads page cuts a long image at its start, so its tag shows, as each kind's own list
  does.
- Lists' headers show whole at the default window, with room for the sort arrow: Events' Count
  and Last seen, Volume Claims' Storage class, and Pods' Restarts. The label selector's
  placeholder fits, and a table counts its own padding, so it no longer runs a few pixels past
  its edge (where Pods beside the panel cut off Restarts and scrolled sideways).

## [1.16.0] - 2026-10-08

A server notices its settings changed outside Lumovi and keeps the stricter, the sidebar has a
sponsor card, and a dialog's error is always in view.

### Added

- On a server, a cluster's settings changed where the server keeps them, outside Lumovi (its
  setting deleted, or an older copy put back), are recorded in the audit log, and the stricter
  is kept: read-only if either was, and its node shells and metrics source as Lumovi last set
  them. Lumovi's admins see it on the cluster's pages, on every replica, until one of them sets
  read-only again. Each setting carries a count that only grows, so that a running server tells
  its own changes from those made by hand, and replicas that haven't read each other's latest
  don't undo them, whichever reads what first. Entries that don't open with a server's key
  (another replica's, while keys are rotated) are left as they are until they've been unchanged
  for 15 minutes, then let go; anything else there, which no key made, at once.
- The sidebar has one sponsor card, above its footer, in the desktop app, a server's web UI and
  a fleet's hub. It shows Lumovi's own ("Help keep Lumovi free."), a sponsor's or none, as
  `sponsor.json` in [Lumovi/main-sponsor](https://github.com/Lumovi/main-sponsor) says, so it
  changes without a release. The desktop app reads it from GitHub a few seconds after starting
  and every hour, and a server reads it for its pages; nothing is sent but the request, and
  nothing is counted. Only plain text, an `https` link and pictures checked by what they are
  (PNG, GIF or WebP, 408 × 136, small enough) are used, shown from Lumovi's own copy. Whatever
  can't be read or doesn't pass shows Lumovi's own card, with no error and no wait. The link's
  domain shows as it's pointed at or focused; an animated picture plays once, and shows its first
  frame still for people who ask for less motion. Under 720 px tall, the card steps aside.

### Changed

- The Helm chart refuses more than one replica without `auth.keepSessions`: each would keep
  who's signed in, and what's set for everyone, in its own memory, and they'd disagree. A server
  keeping its state in memory says to run a single replica.
- On a server, the command palette offers to make a cluster read-only only to those who may, and
  a refused change says who made it read-only, but no longer a date in UTC (the switch says
  when, in your time).
- Lumovi says what it is in one line, the same everywhere: "A calm, fast Kubernetes dashboard,
  on your desktop or in your cluster." In its README, its package, the image's description and the
  chart's (and so Artifact Hub's); the Linux and Arch packages' summaries say it as their tools
  want, with no article or full stop.

### Fixed

- A chart's reference lines (requests, limits, allocatable, what right-sizing recommends) say
  what they are where their labels sit clear of the plotted lines, the other reference lines and
  each other: at either end of their line, above or below it, or a little further off. A label
  with no clear spot (a line the data crosses all along) sits beside its line on a background of
  its own. A threshold above the chart is noted over it, no longer on it.
- A dialog's error is always in view, just above its buttons: in a tall one (a drain's list of
  pods, a chart's values), it no longer lands below where the dialog is scrolled to, so that the
  button seems to do nothing. In Create from YAML, what each object came to is brought into view
  too.

## [1.15.0] - 2026-10-08

kubectl's signature checks keep working as Sigstore and Kubernetes change, and an organization's
policy can require them from its mirror too.

### Added

- A policy can require Kubernetes' signature from its mirror too,
  `"kubectlSignatures": "required"`: a mirror's kubectl is then used only with it, as
  dl.k8s.io's always is, and a terminal says when its mirror keeps none. One taken unsigned
  before isn't used either. A policy that can't be used gets no kubectl at all: terminals use
  the one installed, as with `"kubectl": false`.

### Changed

- Published releases are immutable: once a release is out, GitHub keeps its files and its tag
  from being changed or replaced, and shows it as immutable.
- A terminal whose kubectl's signature is refused says it couldn't be verified as Kubernetes'
  own and may have been changed; or, where it isn't signed as this Lumovi knows Kubernetes signs
  (or under Sigstore's authority and logs as it knows them), that they may have changed, and
  Lumovi needs an update.
- A kubectl Lumovi keeps is used only if what it wrote of it names that kubectl, by its
  SHA-256: one Lumovi stopped while getting again isn't taken for the one it was getting.
- The Sigstore trust root the app checks signatures against is taken through Sigstore's TUF
  repository, checked against its signed metadata, and a weekly check proposes the new one when
  Sigstore changes it (and opens an issue if Kubernetes' instructions name another signer).

## [1.14.0] - 2026-10-08

Behind an authenticating proxy, only the proxy reaches Lumovi, and a fleet's hub trusts an
agent's cluster only with the certificate authority it's named with, or one an admin checks.

### Changed

- Behind an authenticating proxy (`auth.mode: proxy`), the chart lets only the proxy's pods
  reach Lumovi: its NetworkPolicy is always on, and the chart won't install without
  `networkPolicy.from` naming them. Whoever else could reach Lumovi could say they're anyone.
- A fleet's hub trusts an agent's cluster only with the certificate authority it's named with
  (`caSha256`, in `LUMOVI_FLEET_AGENTS`, as `openssl x509 -fingerprint -sha256` prints it), or
  the one the agent first sends: that's kept, and recorded in the audit log, and another is
  refused (the agent and its cluster's card say so). An admin trusts a new one, or checks one
  first sent, by giving its SHA-256 from the cluster itself, in "Agents to check" on the fleet's
  page; the hub's log and the chart's notes say which agents have no `caSha256`.
- An agent's `/healthz` is ready only once its hub trusts its cluster, and says why when it's
  refused. Agents connect to their hub only over https (or http on the same machine).

## [1.13.0] - 2026-10-08

The kubectl terminals download is checked against Kubernetes' signature, and the bill of
materials lists what helm is built from.

### Changed

- The kubectl a terminal downloads is checked against Kubernetes' own signature, not only the
  SHA-256 published beside it: from dl.k8s.io, a kubectl without Kubernetes' signature isn't
  used, and its terminal says why and uses yours. From a mirror that keeps no signatures, the
  terminal says it was checked against its SHA-256 only. One kept by an earlier Lumovi is
  downloaded again, checked. Checked on the computer, against Sigstore's trust root as Lumovi
  ships it: no new connection.
- The desktop app's bill of materials (`Lumovi-<version>.cdx.json`) lists the Go modules the
  helm it ships is built from, and the Go it's built with, as helm itself records them: a
  scanner such as grype now sees a vulnerability in any of them. (The image's bill, made as
  it's built, already did.)

## [1.12.0] - 2026-10-08

Any AI assistant that speaks MCP, and a Codex tab to connect it.

### Changed

- The AI assistants page says what Lumovi is to them, an MCP server, rather than naming a few:
  any assistant or agent that speaks MCP works through it. Connect has a Codex tab, on the
  desktop (its `config.toml`, with Lumovi's token) and on a server (one command, then it signs in
  with OAuth); both checked with Codex 0.161.

## [1.11.0] - 2026-10-07

On a server, a cluster made read-only is read-only for everyone.

### Changed

- On a server, a cluster made read-only is read-only for everyone on it, and their AI
  assistants: the switch says who turned it on, and when, and so does every change it refuses.
  Where its metrics come from and where its node shells run are the server's too. Lumovi's
  admins change them, or anyone where it has none, and each change is in the audit log
  (`read-only.changed`, `metrics-source.changed`, `node-shell.changed`, refusals included). They
  survive a restart where the server keeps its state (the chart's `auth.keepSessions`, or
  `LUMOVI_DATA_DIR`). On the desktop they stay your own, and changing where metrics come from
  is now in its audit log too.
- A release can start the Homebrew tap's update itself, rather than wait for the tap's own
  schedule, which GitHub often skips.

## [1.10.0] - 2026-10-07

A signed Windows installer, and long text that stays in its place everywhere.

### Changed

- The Windows installer is signed, and so is everything it installs: by Open Source Developer
  Péter Kóta, with Certum's certificate. Windows says who it's from, and Lumovi installs only
  updates signed the same way.

### Fixed

- A sign-out the server couldn't keep says so on the sign-in page, however slow the server's
  answer: the page no longer reloads as the connection ends with the session, before the answer
  (and what it says wasn't kept) comes.
- Long text stays in its place, everywhere: names, labels, annotations, images and messages as
  long as Kubernetes allows are cut short with an ellipsis (all of it on hover), or wrap where
  they have the room, and never run over what's beside them. Panels give a long name its own
  line (its status moves beside its actions), images are cut at their start so their tag shows,
  and a list beside a panel says less in its footer rather than wrapping it. A check of every
  page, panel, menu and dialog, with everything at its longest, keeps it so.
- Where a component's look is set for one place (a smaller button, a narrower bar, a dimmer
  label), it now takes: two classes setting the same thing no longer depend on the order the
  stylesheet happens to have them in.
- Menus and popovers grow from what opened them, and those that open upward (at the bottom of
  the sidebar, or flipped to fit) rise rather than drop.
- The stdio bridge AI assistants start follows no redirect: Lumovi's token goes nowhere else.
- What Lumovi remembers of each cluster's version for terminals (`kubectl/clusters.json`, which
  names your contexts) is yours alone (0600), and written whole or not at all.
- A terminal opened as Lumovi starts waits for the kept kubectls to be tidied, which could
  otherwise take away the download it had begun.
- A terminal saying it won't use `LUMOVI_KUBECTL_MIRROR` doesn't show a user and password the
  URL had in it, and the policy's message about `kubectl` says what it takes: an https mirror,
  or an http one on this computer.

## [1.9.1] - 2026-10-07

Security fixes: what an AI assistant's bridge, a cluster or a kubectl mirror can do is narrower.

### Fixed

- The stdio bridge AI assistants such as Claude Desktop start no longer gives Lumovi's token to
  whatever listens on Lumovi's port: while Lumovi isn't running, another program (another
  person's, on a shared computer) could listen there and be given it. The bridge now asks for
  proof that it's Lumovi first (a keyed hash of a challenge, which only what holds the token can
  make), before every request, and doesn't start Lumovi over something else.
- What a cluster says (its version, an error) can no longer write over a terminal's first line:
  Lumovi's own lines leave out control characters, which a terminal would act on (clearing the
  screen, say, or writing over "Lumovi's read-only switch doesn't apply to what you run here").
- A cluster can't choose how old a kubectl a terminal gets: none older than Kubernetes 1.25,
  Lumovi's oldest, whose kubectl lacks years of fixes. Older clusters' terminals use yours.
- A mirror terminals get kubectl from (an organization's policy, or `LUMOVI_KUBECTL_MIRROR`) is
  used only over HTTPS, or on this computer: over plain http, kubectl's checksum comes from the
  same place, and both could be changed on the way.
- A kubectl download a crash cut short is cleaned up as Lumovi starts.
- A terminal for a cluster that can't be reached as Lumovi starts gets the kubectl kept for it:
  each cluster's version is remembered across restarts, not only while Lumovi runs. An empty
  `LUMOVI_KUBECTL_MIRROR` is as good as none.

## [1.9.0] - 2026-10-07

The desktop app brings its own tools: the helm its Helm actions run, and in each terminal, a
kubectl that matches the cluster.

### Added

- Terminals get a kubectl matching their cluster: the newest patch of its Kubernetes version
  (kubectl works a minor version either side of its cluster), downloaded from dl.k8s.io once,
  checked against the SHA-256 published beside it, and kept for every cluster on that version.
  It's first on the terminal's PATH even after your startup files put theirs first (zsh, bash,
  fish, sh and PowerShell). Offline, the newest one kept does; without one, the terminal says
  why and uses yours. A terminal never waits long for it: a cluster that doesn't say its version
  within 3 seconds (its VPN is off, say), or a kubectl still downloading after 10, and it starts
  with yours; the terminals opened after get it. View → Match kubectl to Each Cluster turns it
  off; an organization's policy can too (`"kubectl": false`), or name a mirror of dl.k8s.io to
  get it from.
- The desktop app ships with helm (4.3.0, the image's), which its Helm actions run: installing,
  upgrading, rolling back and uninstalling releases need no helm of your own. `LUMOVI_HELM`
  still names another. Its terminals have it last on their PATH, for when you have none.

## [1.8.0] - 2026-10-07

Lumovi where people get their software (Homebrew, the AUR, the Microsoft Store and Artifact
Hub), and Lumovi in a cluster that a restart signs nobody out of.

### Added

- A restart (an upgrade, say) signs nobody out: sessions, the AI assistants people allowed
  (their tokens), and what each person made read-only for their assistants are kept, in a
  Secret the chart makes (`auth.keepSessions`, on by default; `LUMOVI_STATE_SECRET`) or under
  `LUMOVI_DATA_DIR`. Each entry is sealed (AES-256-GCM), and filed under an HMAC of what it is,
  with a key kept apart from it (`LUMOVI_STATE_KEY`, from a Secret of its own the chart makes, or
  `auth.stateKeySecret`; beside `state.json` without Kubernetes): whoever can read the state
  learns nothing from it, and whoever can write it can't make, change or move an entry that
  opens. No credential is in it either: cookies and tokens by their hash, and a token a session
  passes on (its person's own, with a token or single sign-on that forwards theirs) sealed again
  with a key only its cookie gives. A sign-out, an assistant let go or revoked, is kept before
  it's answered; past what a Secret holds, the sessions that end soonest make way. That one's unsealed as its browser comes
  back, and renewed from then on; until then, its person's assistants say Lumovi restarted
  and to open it, and carry on once they do. Assistants behind a proxy, or whose sessions pass
  no token on, carry on at once.
- Homebrew: `brew install --cask lumovi/tap/lumovi`, from Lumovi's own tap, which follows each
  release once GitHub attests the release workflow built its installers.
- Arch Linux: `lumovi-bin` on the AUR, published with each release (once its maintainer's key
  is set), from Lumovi's own `.deb`; pacman updates it, not Lumovi itself.
- Windows: a Microsoft Store package (MSIX), built with each release for Partner Center:
  Microsoft signs it, and the Store updates it (Lumovi's own updater stays off in it). What it
  writes to AppData isn't redirected into a copy of its own, so kubectl, credential plugins and
  terminals run from it see the same files they do anywhere else.
- Artifact Hub: the chart names the image it runs (so Artifact Hub can scan it), and each release
  pushes the repository's ownership metadata, for a verified publisher.

### Fixed

- The README said the desktop app runs on macOS 12; it needs macOS 13 or later, as Electron does.

## [1.7.0] - 2026-10-07

Lumovi in a company: behind its proxy and its own certificate authorities, rolled out to its
computers with a policy IT locks, and released so its security team can check what it runs.

### Added

- Behind a company's proxy: Lumovi's own connections (to clusters, single sign-on, Helm
  repositories, the audit webhook, a fleet agent's hub) go through `HTTPS_PROXY` /
  `HTTP_PROXY` (`http://` where it gives no scheme), but for what `NO_PROXY` leaves out: names
  and what's under them, and addresses, each with a port or for any, the same for all of them
  (not ranges). A cluster's `proxy-url` in its kubeconfig is used where it has one. The
  desktop app takes the proxy from the login shell, as it takes `PATH`; a server leaves out
  the in-cluster API server and services. A proxy that wants credentials (407), or won't open
  a tunnel, says so; its credentials are never said, nor a proxy that isn't a URL.
- Certificate authorities of a company's own: the operating system's are trusted besides
  Node's (where IT installs the one an HTTPS-inspecting proxy signs with), and on a server
  those in the files `LUMOVI_CA_FILE` names, which Helm is given too. A certificate Lumovi
  doesn't trust, an expired one, or one for another name says which, and what usually makes it
  so behind such a proxy; a file of them that can't be read says which.
- The chart: `proxy.https`, `proxy.http` and `proxy.noProxy`, or `proxy.secret` (a Secret with
  `HTTPS_PROXY`, and `HTTP_PROXY` if plain http goes through one) for a proxy with credentials; `extraCA` (a ConfigMap's or a Secret's certificate authorities); and
  OpenShift's restricted SCC (`restricted-v2`), where the pod's user, group and fsGroup are
  left for OpenShift to choose (`openshift: auto`, by `security.openshift.io/v1`).
- A policy an organization sets for every desktop Lumovi on its computers (deployed by an
  MDM, Group Policy, Intune or configuration management), where only an administrator can
  write it: `/Library/Application Support/Lumovi/policy.json` on macOS and
  `/etc/lumovi/policy.json` on Linux (root's, as is its folder), and the registry's
  `HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Lumovi` (its `Policy` value) on Windows. It makes
  every cluster, or those whose names match, read-only; turns AI assistants off, or limits
  what they may do (rules as a server's `LUMOVI_ASSISTANT_RULES`); turns Lumovi's own updates
  off, for IT to deploy new versions; and sets the proxy and certificate authorities to use.
  What it sets is locked ("Set by your organization"), and the person's own settings are back
  when it's gone. One that can't be used (not an administrator's, not JSON, a key twice, what
  Lumovi doesn't know, a registry Lumovi can't read) locks the most it could: every cluster
  read-only and assistants off, saying why. What the desktop app couldn't set up as it started
  (its policy, a certificate authority's file, a proxy) is said on the page, too.
- Releases carry a software bill of materials (CycloneDX, `Lumovi-<version>.cdx.json`) of
  every package the app bundles or ships, and Electron, attested with each installer; the
  image carries its JavaScript's (attested with it) and its system's, and its full build
  provenance; and the image and the chart are signed with cosign, keyless, by the release
  workflow from main, both as a Sigstore bundle and with the `.sig` tag older admission
  controllers look for. SECURITY.md says how to check each, and how to report a vulnerability:
  security@lumovi.dev.

### Fixed

- What's asked of a cluster as the desktop app starts waits for the login shell's
  environment, so it isn't sent before the proxy (or a credential plugin's `PATH`) is known.

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

[Unreleased]: https://github.com/Lumovi/Lumovi/compare/v1.23.0...HEAD
[1.23.0]: https://github.com/Lumovi/Lumovi/compare/v1.22.1...v1.23.0
[1.22.1]: https://github.com/Lumovi/Lumovi/compare/v1.22.0...v1.22.1
[1.22.0]: https://github.com/Lumovi/Lumovi/compare/v1.21.0...v1.22.0
[1.21.0]: https://github.com/Lumovi/Lumovi/compare/v1.20.0...v1.21.0
[1.20.0]: https://github.com/Lumovi/Lumovi/compare/v1.19.0...v1.20.0
[1.19.0]: https://github.com/Lumovi/Lumovi/compare/v1.18.0...v1.19.0
[1.18.0]: https://github.com/Lumovi/Lumovi/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/Lumovi/Lumovi/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/Lumovi/Lumovi/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/Lumovi/Lumovi/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/Lumovi/Lumovi/compare/v1.13.0...v1.14.0
[1.13.0]: https://github.com/Lumovi/Lumovi/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/Lumovi/Lumovi/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/Lumovi/Lumovi/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/Lumovi/Lumovi/compare/v1.9.1...v1.10.0
[1.9.1]: https://github.com/Lumovi/Lumovi/compare/v1.9.0...v1.9.1
[1.9.0]: https://github.com/Lumovi/Lumovi/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/Lumovi/Lumovi/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/Lumovi/Lumovi/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/Lumovi/Lumovi/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/Lumovi/Lumovi/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/Lumovi/Lumovi/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Lumovi/Lumovi/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/Lumovi/Lumovi/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Lumovi/Lumovi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Lumovi/Lumovi/releases/tag/v1.0.0
