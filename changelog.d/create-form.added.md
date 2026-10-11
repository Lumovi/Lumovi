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
