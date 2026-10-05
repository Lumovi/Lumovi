/**
 * Lumovi's stdio bridge for assistants that start one as a command, run as
 * Node: Lumovi itself, with ELECTRON_RUN_AS_NODE, as `bridge.cjs <settings
 * folder>`. That's how they start it on Windows, where the app's own main
 * process can't read stdin; elsewhere it's `Lumovi --mcp-stdio=<folder>`.
 */
import { runStdio } from './mcp-stdio'

void runStdio({
  settings: process.argv[2]!,
  waitMs: Number(process.env.LUMOVI_MCP_WAIT_MS) || 30_000,
  input: process.stdin,
  output: process.stdout,
})
