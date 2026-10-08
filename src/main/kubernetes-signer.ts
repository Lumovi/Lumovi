/**
 * Who signs Kubernetes' releases, and how they sign in, as Kubernetes' own instructions name them
 * (kubernetes.io, "Verify Signed Kubernetes Artifacts"): a kubectl is taken as Kubernetes' own
 * only if its certificate names both. Kubernetes could change them, and then a Lumovi with these
 * refuses every kubectl, until an update brings the new ones: each week, a workflow checks that
 * the instructions still name these (scripts/kubernetes-signer.ts).
 *
 * On its own, with nothing to import: that check reads it without installing anything.
 */
export const KUBERNETES_SIGNER = {
  identity: 'krel-staging@k8s-releng-prod.iam.gserviceaccount.com',
  issuer: 'https://accounts.google.com',
}
