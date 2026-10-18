- **The Overview draws for an account that may read less.** One that may not list nodes, as
  Kubernetes' own `view` role can't, saw the whole Overview fail with "nodes is forbidden". Now the
  rest of the page draws, and the node parts (Nodes ready, CPU, Memory and Nodes) say the account
  isn't allowed to list nodes. Where node metrics can't be read, because the account may not read
  them or the read fails, CPU and Memory no longer stay "Measuring…": they show what's requested
  and say why there's no live usage. With only one cluster, an Overview that fails no longer offers
  "Choose another cluster".
