- **A kubeconfig user that signs in with `auth-provider: oidc` stays signed in.** Once its ID
  token had expired, Lumovi couldn't get credentials for the cluster. Now it renews the token from
  the issuer with the refresh token, as kubectl does. In the desktop app, it writes the new tokens
  back to the kubeconfig the user came from, as kubectl writes them, under kubectl's lock. Only
  that user's `id-token` and `refresh-token` change, and comments and everything else stay as they
  were. Where the file can't be written, Lumovi keeps the tokens until it quits, and says so. When
  a renewal fails, the cluster says why Lumovi couldn't sign in. A server keeps renewed tokens in
  memory only and never writes its kubeconfig.
