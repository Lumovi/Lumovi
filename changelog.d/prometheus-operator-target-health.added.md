- **Prometheus Operator's plugin has a Target health page**: what's up, down and not scraped yet,
  the targets that are down with their last error, and each Prometheus server's scrape pools. It's
  the first plugin to ask its tool's own server in the cluster: in each namespace with a
  Prometheus it asks the `prometheus-operated` Service for its active targets, through Lumovi and
  as you. What the server answers reaches the plugin's code: every active target, with the labels
  and annotations of the Services and Pods behind it, from every namespace that Prometheus
  watches. The Plugins page says so first, in red, each ask is in the history, and an
  organization's policy can turn it off (`pluginServers: off`). A Prometheus scrapes across
  namespaces: whoever may reach its server sees all its targets, and each card says so.
