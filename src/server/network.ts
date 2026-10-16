/**
 * Where a server may fetch charts from. People choose chart repositories and
 * registries, and the server fetches from them: from inside the cluster's
 * network, where it can reach services they can't, and cloud metadata
 * endpoints. So unless LUMOVI_ALLOW_PRIVATE_CHARTS allows them, it only
 * fetches from public addresses.
 */
import { KubeRequestError } from '@backend/kube/errors'
import { privateHost } from '@backend/network'

/** Refuses a URL whose host is (or resolves to) a private address. */
export async function checkChartUrl(url: string): Promise<void> {
  const host = await privateHost(url)
  if (host) {
    throw new KubeRequestError(
      'invalid',
      `Lumovi doesn’t fetch charts from ${host}: it’s in a private network. An administrator can allow that with LUMOVI_ALLOW_PRIVATE_CHARTS.`,
    )
  }
}
