/**
 * Someone's groups from Microsoft Graph, for when they're in too many for their ID token:
 * Microsoft Entra ID then puts none in it, only a mark that they're elsewhere (its groups
 * overage). They're read as that person, with their own token and delegated User.Read, which
 * reads their own memberships and nobody else's: the security groups they're in, directly or
 * through other groups, by id, as their ID token names them.
 *
 * User.Read is the least privileged permission Microsoft lists for POST /me/getMemberObjects
 * (v1.0, "Memberships for the signed-in user"):
 * https://learn.microsoft.com/en-us/graph/api/directoryobject-getmemberobjects?view=graph-rest-1.0
 */
import { fetchFailure } from '@backend/network'

const TIMEOUT_MS = 20_000
/** Ids at most: Graph answers with no more than about 11,000. */
const MOST_BYTES = 2 * 1024 * 1024
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Graph didn't take the token (it's for something else, or can't read memberships): 401 or 403. */
export class GraphRefused extends Error {}

/** The security groups whoever `token` is for is in; throws when Graph doesn't say. */
export async function memberGroups(graphUrl: string, token: string): Promise<string[]> {
  const response = await fetch(`${graphUrl}/v1.0/me/getMemberObjects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ securityEnabledOnly: true }),
    // Their token goes to Graph and nowhere else.
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error: Error) => {
    throw new Error(`Couldn’t reach Microsoft Graph: ${fetchFailure(error)}`)
  })
  if (!response.ok) {
    const said = `Microsoft Graph answered ${response.status}${await codeOf(response)}`
    throw response.status === 401 || response.status === 403
      ? new GraphRefused(said)
      : new Error(said)
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of response.body ?? []) {
    size += (chunk as Uint8Array).length
    if (size > MOST_BYTES) throw new Error('Microsoft Graph’s answer was too long to be groups')
    chunks.push(Buffer.from(chunk as Uint8Array))
  }
  let ids: unknown
  try {
    ids = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { value?: unknown }).value
  } catch {
    ids = undefined
  }
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && ID.test(id))) {
    throw new Error('Microsoft Graph’s answer wasn’t a list of group ids')
  }
  return ids as string[]
}

/** Graph's error code, as it said it (`: InvalidAuthenticationToken`), kept short and plain. */
async function codeOf(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  let code: unknown
  try {
    code = (JSON.parse(text) as { error?: { code?: unknown } }).error?.code
  } catch {
    return ''
  }
  return typeof code === 'string' ? `: ${code.replace(/[^\w.-]/g, '').slice(0, 60)}` : ''
}
