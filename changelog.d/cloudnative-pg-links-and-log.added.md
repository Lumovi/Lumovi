- **CloudNativePG's Overview links to Lumovi's own places** for the cluster picked: **Shell into
  primary** and **Forward 5432** open the primary pod's Shell tab and its Port forward, each
  instance's row opens that pod's logs, and the primary's log is on the page. A link only says
  where to go: a shell or a forward still starts only when you start it there, and Lumovi reads
  the log itself, so the plugin's code never holds a line of it. An organization's policy can keep
  plugins from showing logs (`pluginLogs: off`).
