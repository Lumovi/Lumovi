- **Flux's and Argo CD's plugins say what their objects manage.** A workload that a Flux
  Kustomization or HelmRelease manages, by Flux's own labels, or that an Argo CD Application
  manages, by Argo CD's tracking annotation, says so in its list's **Managed by** column and on
  its Overview. Where Argo CD tracks by the `app.kubernetes.io/instance` label, it isn't
  recognised: any chart can set that label, so a plugin can't name it.
