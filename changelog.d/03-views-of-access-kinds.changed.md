- A view, in a plugin of your own, for ServiceAccounts, Roles, ClusterRoles or their bindings now
  only adds its actions, as a view of any kind with its own page does: its columns, status,
  details and related lists no longer show, since those kinds have pages of their own now. A
  plugin of your own that names one of them among its kinds is refused, and the API resources
  page says which.
