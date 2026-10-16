- Links to what you're looking at. **Copy link** in an object's More actions, and **Copy link to
  this view** in a page's menu, copy a `lumovi://` link. Where the same cluster is in someone's
  kubeconfig, under any name, it opens the same object or view in their desktop app. A link only
  shows: it never carries a credential, never opens a shell, an attach or a port forward, and
  changes nothing. Every link asks first, naming the cluster as your kubeconfig calls it, and one
  to a cluster you don't have says so, with Add a cluster. An organization can turn links off with
  the policy key `"links": "off"`.
