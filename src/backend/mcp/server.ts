/**
 * Lumovi's MCP server: one for each assistant's session, with the tools that
 * read clusters and ask to change them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools, type ToolContext } from './tools'

/** What an assistant is told about Lumovi when it connects. */
export const INSTRUCTIONS = `Lumovi shows Kubernetes clusters: the contexts of the user's kubeconfig. Start with list_clusters.
To see what's wrong, find_problems is the quickest; then get_resource, get_events and get_logs on what it finds.
Changes (apply_manifest, scale, restart, delete_resource) are shown to the user in Lumovi with the diff they make and their kubectl command, and made only if the user approves them (unless their cluster lets assistants change it without asking). The call waits for the answer up to a minute; if it says it's still waiting, call wait_for_change with the id it gives, until the user answers. Say in reason what's wrong and how the change helps, and tell the user to look at Lumovi. A rejection may come with a note: follow it. Read-only clusters take no changes, and some take none from assistants.
Secret values are never shown.`

/** What Lumovi calls the assistants it knows, by the names they give themselves. */
const NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-ai': 'Claude',
  'cursor-vscode': 'Cursor',
  'Visual Studio Code': 'VS Code',
  'Visual Studio Code - Insiders': 'VS Code',
  'windsurf-client': 'Windsurf',
  'codex-mcp-client': 'Codex',
}

/** An assistant as Lumovi shows it ("Claude Code"), once it has said who it is. */
export function assistantName(server: McpServer): string {
  const info = server.server.getClientVersion()!
  return NAMES[info.name] ?? info.title ?? info.name
}

export function createMcpServer(version: string, tools: Omit<ToolContext, 'client'>): McpServer {
  const server = new McpServer(
    { name: 'lumovi', title: 'Lumovi', version },
    { instructions: INSTRUCTIONS },
  )
  registerTools(server, {
    ...tools,
    // Tools are called once it has said who it is.
    client: () => assistantName(server),
  })
  return server
}
