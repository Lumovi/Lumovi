- **The Managed by column with every namespace in view**: where the person may not list a
  manager's kind (Argo CD's Applications, say) in the whole cluster, Lumovi read it again and
  again, many times a second, as long as the list was open. It now reads it once, as it does with
  some namespaces picked.
