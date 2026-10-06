/**
 * Lumovi's MCP server for assistants that start one as a command and talk to
 * it over stdin and stdout (Claude Desktop): `Lumovi --mcp-stdio=<settings
 * folder>`, or on Windows, run as Node (mcp-node.ts). It opens no window: it
 * passes their messages on to the desktop app's server, which it finds (and
 * its token) in Lumovi's settings, and starts Lumovi when it isn't running.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { isPort, isToken } from '@shared/assistants'

interface Message {
  jsonrpc: '2.0'
  id?: string | number | null
  method?: string
  result?: { protocolVersion?: string }
  error?: { code: number; message: string }
}

/** The argument that starts Lumovi as this, with its settings folder after it. */
export const STDIO = '--mcp-stdio='

export interface StdioOptions {
  /** Lumovi's settings folder. */
  settings: string
  /** How long Lumovi is given to start listening, when it has to be started. */
  waitMs: number
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
}

/** Passes messages on until the assistant closes stdin. */
export async function runStdio(o: StdioOptions): Promise<void> {
  let session: string | null = null
  let protocol: string | undefined
  /** The assistant's initialize, to start a new session with when Lumovi's has ended. */
  let initialize: Message | undefined

  const write = (message: Message) => o.output.write(`${JSON.stringify(message)}\n`)
  const fail = (id: Message['id'], message: string, code = -32000) =>
    write({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  /** Where the desktop app listens, its token, and how it's started, as its settings say. */
  const endpoint = () => {
    let assistants:
      { enabled?: boolean; port?: number; token?: string; launch?: string[] } | undefined
    try {
      assistants = JSON.parse(readFileSync(join(o.settings, 'settings.json'), 'utf8')).assistants
    } catch {
      // No settings yet: Lumovi hasn't been opened.
    }
    if (!assistants?.enabled || !isToken(assistants.token)) {
      throw new Error(
        'AI assistants are turned off in Lumovi: open Lumovi, and turn them on in its AI assistants settings.',
      )
    }
    // A port, and nothing else: the token is only ever sent to this computer.
    if (!isPort(assistants.port)) {
      throw new Error(
        'Lumovi’s settings name no port it listens on: open Lumovi, and choose AI assistants’ port again.',
      )
    }
    return {
      url: `http://127.0.0.1:${assistants.port}/mcp`,
      token: assistants.token,
      launch: assistants.launch,
    }
  }

  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(session ? { 'Mcp-Session-Id': session } : {}),
    ...(protocol ? { 'Mcp-Protocol-Version': protocol } : {}),
  })

  /** Starts Lumovi, as it was last started, and waits until it listens. */
  const start = async () => {
    const { launch } = endpoint()
    // Lumovi says how it was started when it starts: one that never has, can't be.
    if (!launch) throw new Error('Lumovi isn’t running: open it, and try again.')
    const [command, ...args] = launch
    // As the app, not as Node (as the bridge may be running).
    const { ELECTRON_RUN_AS_NODE: _asNode, ...env } = process.env
    spawn(command!, args, { detached: true, stdio: 'ignore', env })
      // Not there (moved, say): it doesn't start, which the wait below says.
      .on('error', () => {})
      .unref()
    const until = Date.now() + o.waitMs
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      try {
        await fetch(endpoint().url, { method: 'HEAD' })
        return
      } catch {
        // Not yet.
      }
    }
    throw new Error('Lumovi didn’t start: open it, and check that AI assistants are on.')
  }

  const post = (message: Message) => {
    const { url, token } = endpoint()
    return fetch(url, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify(message),
    }).catch(() => {
      throw new Error('Lumovi isn’t answering: open it, and try again.')
    })
  }

  /** Sends `message`, and passes on what comes back. */
  const send = async (message: Message, again = true): Promise<void> => {
    let response: Response
    try {
      response = await post(message)
    } catch {
      // Not running: started, then asked again. (The first message is the assistant's
      // initialize, which it waits for: nothing else waits with it.)
      await start()
      response = await post(message)
    }
    // Lumovi restarted, and its session went with it: a new one, as the assistant began it.
    if (response.status === 404 && session && initialize && again) {
      session = null
      await send(initialize, false)
      await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, false)
      return send(message, false)
    }
    if (message.method === 'initialize') session = response.headers.get('mcp-session-id')
    for await (const reply of replies(response)) {
      if (reply.id === message.id && reply.result?.protocolVersion) {
        protocol = reply.result.protocolVersion
      }
      // The assistant has its answer to the first initialize already.
      if (message === initialize && !again) continue
      // Lumovi's refusals name no request: they're this one's (a notification has nobody to tell).
      if (reply.id !== null) write(reply)
      else if (message.id !== undefined) write({ ...reply, id: message.id })
    }
  }

  const pending = new Set<Promise<unknown>>()
  for await (const line of createInterface({ input: o.input })) {
    if (!line.trim()) continue
    let message: Message
    try {
      message = JSON.parse(line)
    } catch {
      fail(null, 'That isn’t a JSON-RPC message.', -32700)
      continue
    }
    if (message.method === 'initialize') initialize = message
    const sent = send(message)
      // A notification has nobody to tell.
      .catch((error: Error) => message.id !== undefined && fail(message.id, error.message))
      .finally(() => pending.delete(sent))
    pending.add(sent)
  }
  await Promise.all(pending)
  // The assistant has gone: so has its session.
  if (session) {
    try {
      const { url, token } = endpoint()
      await fetch(url, { method: 'DELETE', headers: headers(token) })
    } catch {
      // Lumovi has gone too.
    }
  }
}

/** The messages in a response: a stream of events, a refusal, or none (a notification's). */
async function* replies(response: Response): AsyncGenerator<Message> {
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        // Lumovi's events are one message each, on a line of its own.
        for (const line of event.split('\n')) {
          if (line.startsWith('data:')) yield JSON.parse(line.slice(5)) as Message
        }
      }
    }
    return
  }
  const text = await response.text()
  if (text) yield JSON.parse(text) as Message
}
