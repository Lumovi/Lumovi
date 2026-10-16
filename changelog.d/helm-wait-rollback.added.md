- **Helm: wait, undo, timeout, and what a rollback changes.** Installing a chart and upgrading a
  release can wait until what Helm made is ready, undo it if it fails (an upgrade rolled back, an
  install uninstalled), and give Helm a timeout, each with Helm's own flag beside it; while it
  waits, the dialog says how long, and closing it doesn't stop Helm (quitting Lumovi asks first).
  Rolling back shows what it changes: the values by key, and the manifest's differences, with
  Secrets' values masked until revealed.
