- **Add a cluster from AWS.** Add a cluster has a third way in, From AWS. When you choose Find
  clusters, and only then, Lumovi runs your own `aws` CLI, as you, to list your profiles and the EKS
  clusters each one has in the regions you give. One you add signs in with `aws eks get-token` as
  its profile, a command you agree to first, and goes in a group named for its account and region.
  Lumovi reads nothing of `~/.aws` itself and keeps no credential.
