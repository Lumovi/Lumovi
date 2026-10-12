- Nodes have taints: add and remove them, with what each effect does, and a warning before a
  NoExecute taint evicts pods. Drain takes a grace period, a timeout, and whether to leave
  DaemonSet pods; a pod a PodDisruptionBudget holds is tried again, and its row says which budget
  and why.
