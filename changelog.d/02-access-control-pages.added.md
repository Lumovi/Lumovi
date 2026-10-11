- Service accounts, roles and bindings have pages of their own, under **Access control** in the
  sidebar: Roles, Cluster Roles, Role Bindings, Cluster Role Bindings and Service Accounts, each
  also in the command palette and `g` navigation (`g r`, `g k`, `g b`, `g g`, `g t`). A role's
  rules read as a table of API groups, resources and verbs. The links go both ways: a binding
  links its role and its subjects, a role lists the bindings that grant it and to whom, a
  service account lists the bindings that name it and the role each grants, and a workload and
  its pods link the service account they act as. Someone who may not list one of these kinds
  is told so, on its page and in the panels that would have listed it.
