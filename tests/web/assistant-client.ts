/**
 * An AI assistant, as the tests play one: the MCP SDK's own client, signed in
 * to a Lumovi server with OAuth as the person a page is signed in as.
 */
import type { Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Assistant, callback } from './assistant-oauth.ts'
import { expect, type Served } from './fixtures.ts'

export { Assistant, callback }

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
