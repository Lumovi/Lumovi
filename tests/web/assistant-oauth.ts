/**
 * An AI assistant's OAuth, as the tests (and the screenshots) play one: where it's sent back to
 * with its code, and the MCP SDK's provider that registers it and keeps its tokens. Nothing of
 * the tests' own here, so the screenshots can sign one in too.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

/** Where an assistant is sent back to with its code: a server of its own, on this computer. */
export async function callback(): Promise<{
  url: string
  answer: Promise<URLSearchParams>
  close(): void
}> {
  let answered!: (query: URLSearchParams) => void
  const answer = new Promise<URLSearchParams>((resolve) => (answered = resolve))
  const server = createServer((req, res) => {
    answered(new URL(req.url!, 'http://127.0.0.1').searchParams)
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('You can close this tab.')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/callback`, answer, close: () => server.close() }
}

/** An assistant, as the MCP SDK signs one in: it registers, sends the person to Lumovi, and keeps its tokens. */
export class Assistant implements OAuthClientProvider {
  authorizationUrl?: URL
  #client?: OAuthClientInformationMixed
  #tokens?: OAuthTokens
  #verifier = ''

  readonly redirectUrl: string
  readonly name: string
  // (Fields set by hand, not as parameters: the screenshots run this as Node strips its types.)
  constructor(redirectUrl: string, name = 'Claude Code (lumovi)') {
    this.redirectUrl = redirectUrl
    this.name = name
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.name,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  clientInformation() {
    return this.#client
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.#client = client
  }
  tokens() {
    return this.#tokens
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier
  }
  codeVerifier() {
    return this.#verifier
  }
}
