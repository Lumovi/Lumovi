- **Search the cluster.** A Search page (in the sidebar, ⌘⇧F or Ctrl+Shift+F, and from the palette)
  finds objects of the kinds you may list, by part of their name or by their labels (`app=web`,
  `tier!=db`, `team=*`, `!canary`), in the namespaces picked, grouped by kind, each with its status.
  Only names, namespaces, labels and ages are read, never what objects hold. A kind too large to
  read whole says how much was searched, and a label search asks it again for just those labels. The
  palette shows matching objects as you type. Searches can be saved, and the first nine run with ⌥⇧1
  to ⌥⇧9 (Ctrl+Shift on Windows, Alt+Shift on Linux).
