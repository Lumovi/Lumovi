- **One object's name and namespace are checked before the cluster is asked.** Every call that
  takes an object's name or a namespace now refuses one Kubernetes wouldn't accept, in Lumovi's
  own words (a pod's, a node's or a Service's is a DNS name), and a read of one object of a kind
  that's in a namespace needs its namespace. No request is sent with a `.` or `..` path segment,
  written plainly or escaped, or with an address that reads differently from its path, and a read
  or change of one object whose answer isn't that object is refused.
