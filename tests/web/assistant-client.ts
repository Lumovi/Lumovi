/**
 * An AI assistant, as the tests play one: the MCP SDK's own client, signed in
 * to a Lumovi server with OAuth as the person a page is signed in as.
 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { expect, type Served } from './fixtures.ts'

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

  constructor(
    readonly redirectUrl: string,
    readonly name = 'Claude Code (lumovi)',
  ) {}

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

/**
 * An assistant connected to `served` as whoever `page` is signed in as: it
 * asks, the person allows it on Lumovi's page, and it signs in with the code.
 */
export async function connect(
  page: Page,
  served: Served,
  {
    name = 'claude-code',
    clientName = 'Claude Code (lumovi)',
    beforeAllow,
  }: {
    name?: string
    clientName?: string
    /** What a test looks at on Lumovi's page, before the person allows it. */
    beforeAllow?: () => Promise<void>
  } = {},
) {
  const back = await callback()
  const assistant = new Assistant(back.url, clientName)
  const endpoint = new URL('mcp', served.url)
  const first = new Client({ name, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(endpoint, { authProvider: assistant })
  await expect(first.connect(transport)).rejects.toThrow(UnauthorizedError)
  await page.goto(assistant.authorizationUrl!.href)
  await beforeAllow?.()
  await page.getByRole('button', { name: 'Allow' }).click()
  const answer = await back.answer
  await page.waitForURL((url) => url.href.startsWith(back.url))
  back.close()
  await transport.finishAuth(answer.get('code')!)
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: assistant }))
  return { client, assistant }
}

/** A tool's answer, as text, and whether it's an error. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  options?: RequestOptions,
): Promise<{ text: string; error: boolean }> {
  const result = (await client.callTool(
    { name, arguments: args },
    undefined,
    options,
  )) as CallToolResult
  return { text: (result.content[0] as { text: string }).text, error: result.isError === true }
}
