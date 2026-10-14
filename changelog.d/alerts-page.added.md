- **Alerts**, a page of its own under Cluster, beside Events (`g z`, and in the palette): what the
  cluster's Prometheus is firing and has pending, read from the source the Metrics page uses,
  through the cluster as you, every 30 seconds while it's open. The worst come first, each with its
  severity, how long it has fired or when it fires if its condition holds, the object its labels
  name, as a link, and how long it has been active. They filter by the header's namespaces, by
  severity, by firing or pending, and by text. One opens beside the list with its summary,
  description, labels, rule and runbook. An alert of severity none, like Watchdog, never counts as
  firing. Whoever may reach Prometheus through the cluster sees every alert it holds. Where alerts
  fire, the Overview's Warnings tile says how many, with a link.
