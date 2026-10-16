- **Compare with…**, in an object's More actions and the command palette, sets an object beside
  another of its kind, from another namespace or another cluster, and shows what differs, its
  status included. What the cluster sets itself (uids, versions, times, addresses) is left out
  until you ask for it. A workload's ConfigMaps and Secrets are compared with it, paired by where
  it refers to them. Each side is read with your own access on its cluster: Secrets' values stay
  masked until revealed, and where either side shows a Secret's keys only, only keys are compared.
  Nothing signs in by itself: a cluster that signs in through a program is read only when you open
  it.
