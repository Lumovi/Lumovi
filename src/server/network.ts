/**
 * Where a server may fetch charts from. People choose chart repositories and
 * registries, and the server fetches from them: from inside the cluster's
 * network, where it can reach services they can't, and cloud metadata
 * endpoints. So unless LUMOVI_ALLOW_PRIVATE_CHARTS allows them, it only
 * fetches from public addresses, and connects to the one it checked
 * (fetchPublic): Lumovi fetches every chart itself, and hands Helm the file.
 */
import { KubeRequestError } from '@backend/kube/errors'
import { fetchPublic, privateHost } from '@backend/network'

const refusal = (host: string) =>
  `Lumovi doesn’t fetch charts from ${host}: it’s in a private network. An administrator can allow that with LUMOVI_ALLOW_PRIVATE_CHARTS.`

/** Refuses a URL whose host is (or resolves to) a private address. */
export async function checkChartUrl(url: string): Promise<void> {
  const host = await privateHost(url)
  if (host) throw new KubeRequestError('invalid', refusal(host))
}

/** Fetches from a public address alone, the one checked: how charts and their icons come. */
export const fetchChart: typeof globalThis.fetch = (input, init) =>
  fetchPublic(input, init, refusal)
