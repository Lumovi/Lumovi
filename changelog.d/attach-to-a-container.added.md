- **Attach to a container's main process**, as `kubectl attach -it` does: **Attach** in a pod's
  actions, or on its Shell tab beside Shell. What the process prints shows, and what you type goes
  to it, Ctrl+C included; closing the tab detaches and leaves it running. A container whose input closes after one
  session (`stdinOnce`) is sent nothing, since detaching would end it, and one that takes no input
  shows what it prints. It's in the audit history with its command, and it's allowed where shells
  are: by your access on a server, the cluster's RBAC (`pods/attach`), and not on a read-only
  cluster.
