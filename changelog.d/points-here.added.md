- **An object's detail lists what points at it**: a plugin's link with `listedThere` is listed in
  the detail of the object it names too, under **Objects that point here** on its Overview,
  grouped by plugin, each with its kind, what it's `about` and its view's status, and opening it.
  They're the objects whose labels name it, what it belongs to, or, for a Deployment, the
  ReplicaSets it runs (as Trivy's reports do). Lumovi finds them by those labels, in the object's
  namespace (anywhere, for one outside namespaces), and the Plugins page says so. Where no plugin
  asks, nothing more is read, and no plugin's code runs on Lumovi's own detail.
