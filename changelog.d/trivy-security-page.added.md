- **Trivy Operator's plugin draws a Security page** of what to fix first: vulnerabilities by
  workload and by image, those with a fix first; critical and high by namespace, and fixable by
  package; exposed secrets, never the text that matched; misconfigurations and RBAC. A
  VulnerabilityReport gets a **Vulnerabilities** tab with every vulnerability in its image, those
  with a fix first. Besides Trivy's reports, it reads ReplicaSets' names, owners, replica counts
  and creation times, never what they run, to count a ReplicaSet's report as its Deployment's
  (Lumovi-plugins 1.6.0).
