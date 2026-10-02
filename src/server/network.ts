/**
 * Where a server may fetch charts from. People choose chart repositories and
 * registries, and the server fetches from them: from inside the cluster's
 * network, where it can reach services they can't, and cloud metadata
 * endpoints. So unless KUBESTACKS_ALLOW_PRIVATE_CHARTS allows them, it only
 * fetches from public addresses.
 */
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { KubeRequestError } from '@backend/kube/errors'

const PRIVATE = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "This network"
  ['10.0.0.0', 8], // Private
  ['100.64.0.0', 10], // Shared address space (carrier-grade NAT, some pod networks)
  ['127.0.0.0', 8], // Loopback
  ['169.254.0.0', 16], // Link-local: cloud metadata endpoints
  ['172.16.0.0', 12], // Private
  ['192.168.0.0', 16], // Private
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128], // Unspecified
  ['::1', 128], // Loopback
  ['fc00::', 7], // Unique local
  ['fe80::', 10], // Link-local
] as const) {
  PRIVATE.addSubnet(network, prefix, 'ipv6')
}

/** Refuses a URL whose host is (or resolves to) a private address. */
export async function checkChartUrl(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1')
  // Names that don't resolve fail later, as helm tries them.
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => [])
  if (addresses.some(({ address, family }) => PRIVATE.check(address, `ipv${family}` as 'ipv4'))) {
    throw new KubeRequestError(
      'invalid',
      `KubeStacks doesn’t fetch charts from ${host}: it’s in a private network. An administrator can allow that with KUBESTACKS_ALLOW_PRIVATE_CHARTS.`,
    )
  }
}
