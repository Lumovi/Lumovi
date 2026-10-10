/**
 * The streaming endpoints of the mock API server: `exec` gets a tiny shell,
 * and `portforward` reaches a pod that answers HTTP, both over the
 * WebSocket channel protocols the real API server speaks.
 */
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { containerFiles } from './files.ts'
import type { Json, KubeObject } from './types.ts'

const STDOUT = 1
const ERROR = 3
const RESIZE = 4

/** A WebSocket frame on a channel: the channel's number, then the data. */
function frame(channel: number, data: string | Buffer): Buffer {
  return Buffer.concat([Buffer.from([channel]), Buffer.from(data)])
}

const success = { metadata: {}, status: 'Success' }
const failure = (message: string, reason = 'InternalError', details?: Json) => ({
  metadata: {},
  status: 'Failure',
  message,
  reason,
  ...(details ? { details } : {}),
})

/** Images that ship without a shell, like distroless ones. */
const SHELLLESS = /distroless|metrics-server/

/** What a shell is like where it runs: its prompt, host name, folder and files. */
interface Place {
  prompt: string
  hostname: string
  pwd: string
  ls: string
}

/** The node's files, as a node shell sees them. */
const NODE_FILES =
  'bin  boot  dev  etc  home  lib  opt  proc  root  run  sbin  srv  sys  tmp  usr  var'

/**
 * Where a shell runs: in the container, or, in a node shell's pod (command
 * ['env', …, 'nsenter', …] or [… 'cd /host' …]), on its node or in the pod.
 */
function placeOf(pod: KubeObject, command: string[]): Place {
  const node = pod.spec.nodeName as string
  if (command.includes('nsenter')) {
    return { prompt: `root@${node}:~# `, hostname: node, pwd: '/root', ls: NODE_FILES }
  }
  if (command.some((arg) => arg.includes('cd /host'))) {
    return { prompt: '/host # ', hostname: node, pwd: '/host', ls: NODE_FILES }
  }
  const name = pod.metadata.name
  return {
    prompt: `root@${name}:/# `,
    hostname: name,
    pwd: '/',
    ls: 'app  bin  dev  etc  home  proc  root  sys  tmp  usr  var',
  }
}

/** A shell good enough to type into: echo, a prompt, a few commands, `exit`. */
function shell(socket: WebSocket, pod: KubeObject, container: string, place: Place) {
  const name = place.hostname
  const size = { columns: 80, rows: 24 }
  let line = ''
  const write = (text: string) => socket.send(frame(STDOUT, text))
  const prompt = () => write(place.prompt)
  const exit = (code: number) => {
    socket.send(
      frame(
        ERROR,
        JSON.stringify(
          code === 0
            ? success
            : failure(
                `command terminated with non-zero exit code: error executing command [sh], exit code ${code}`,
                'NonZeroExitCode',
                {
                  causes: [{ reason: 'ExitCode', message: String(code) }],
                },
              ),
        ),
      ),
    )
    socket.close()
  }
  const run = (input: string) => {
    const [command = '', ...args] = input.trim().split(/\s+/)
    const env: { name: string; value?: string }[] =
      pod.spec.containers.find((c: Json) => c.name === container)?.env ?? []
    const output: Record<string, () => string> = {
      '': () => '',
      hostname: () => name,
      whoami: () => 'root',
      pwd: () => place.pwd,
      ls: () => place.ls,
      echo: () => args.join(' '),
      env: () =>
        [
          `HOSTNAME=${name}`,
          'KUBERNETES_SERVICE_HOST=10.96.0.1',
          ...env.map((e) => `${e.name}=${e.value ?? ''}`),
        ].join('\r\n'),
      stty: () => (args[0] === 'size' ? `${size.rows} ${size.columns}` : ''),
    }
    if (command === 'exit') return exit(Number(args[0] ?? 0))
    // The container's own process gone (as when its pod is deleted): the stream closes, unsaid.
    if (command === 'kill' && args.at(-1) === '1') return socket.close()
    const result = output[command]?.() ?? `sh: ${command}: not found`
    if (result) write(`${result}\r\n`)
    prompt()
  }
  prompt()
  return {
    input(data: string) {
      for (const char of data) {
        if (char === '\r') {
          write('\r\n')
          const typed = line
          line = ''
          run(typed)
        } else if (char === '\x7f') {
          if (line) {
            line = line.slice(0, -1)
            write('\b \b')
          }
        } else if (char === '\x03') {
          line = ''
          write('^C\r\n')
          prompt()
        } else if (char === '\x04' && line === '') {
          exit(0)
        } else if (char >= ' ') {
          line += char
          write(char)
        }
      }
    },
    resize(columns: number, rows: number) {
      size.columns = columns
      size.rows = rows
    },
  }
}

/** A pod that answers any HTTP request on a forwarded port, saying who it is. */
function forward(socket: WebSocket, pod: KubeObject, port: number) {
  const portBytes = Buffer.alloc(2)
  portBytes.writeUInt16LE(port)
  // Each port's data and error streams start with the port number.
  socket.send(frame(0, portBytes))
  socket.send(frame(1, portBytes))
  let request = ''
  return {
    input(data: Buffer) {
      request += data.toString('latin1')
      if (!request.includes('\r\n\r\n')) return
      const path = request.split(' ')[1] ?? '/'
      const body = `Hello from ${pod.metadata.name}:${port}${path}\n`
      request = ''
      socket.send(
        frame(
          0,
          `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        ),
      )
    },
  }
}

export interface StreamContext {
  /** The stored pod, if there is one. */
  pod(namespace: string, name: string): KubeObject | undefined
  /** The stored node. */
  node(name: string): KubeObject | undefined
  /**
   * Whether the request may go on: false after the context has answered it (401, 403, a
   * fault…), or a delay in milliseconds before it goes on.
   */
  admit(
    req: http.IncomingMessage,
    socket: Duplex,
    subresource: 'exec' | 'portforward',
  ): boolean | number
}

/** Answers WebSocket upgrades for pods' `exec` and `portforward` subresources. */
export function streamingEndpoints(context: StreamContext) {
  const wss = new WebSocketServer({
    noServer: true,
    // v5 adds a way to close stdin; the client asks for it first.
    handleProtocols: (protocols) =>
      ['v5.channel.k8s.io', 'v4.channel.k8s.io'].find((p) => protocols.has(p)) ?? false,
  })
  const reject = (socket: Duplex, status: number, message: string) => {
    const body = JSON.stringify(failure(message))
    socket.end(
      `HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Bad Request'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
  }

  const upgrade = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://mock')
    const match = url.pathname.match(
      /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/(exec|portforward)$/,
    )
    if (!match) return reject(socket, 404, 'the server could not find the requested resource')
    const [, namespace, name, subresource] = match as unknown as [
      string,
      string,
      string,
      'exec' | 'portforward',
    ]
    const admitted = context.admit(req, socket, subresource)
    if (admitted === false) return
    if (typeof admitted === 'number') {
      setTimeout(() => serve(req, socket, head, url, namespace, name, subresource), admitted)
    } else {
      serve(req, socket, head, url, namespace, name, subresource)
    }
  }

  const shells = new Set<WebSocket>()
  const tunnels = new Set<WebSocket>()
  // What `tar` reads and writes in the containers (`kubectl cp`, over exec).
  const files = containerFiles()
  const serve = (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    namespace: string,
    name: string,
    subresource: 'exec' | 'portforward',
  ) => {
    const pod = context.pod(namespace, name)
    if (!pod) return reject(socket, 404, `pods "${name}" not found`)

    if (subresource === 'portforward') {
      const port = Number(url.searchParams.get('ports'))
      wss.handleUpgrade(req, socket, head, (ws) => {
        tunnels.add(ws)
        ws.on('close', () => tunnels.delete(ws))
        const target = forward(ws, pod, port)
        ws.on('message', (data: Buffer) => {
          if (data[0] === 0) target.input(data.subarray(1))
        })
      })
      return
    }

    const container = url.searchParams.get('container') ?? ''
    const status = [
      ...(pod.status?.containerStatuses ?? []),
      ...(pod.status?.ephemeralContainerStatuses ?? []),
    ].find((s: Json) => s.name === container)
    if (!status) {
      return reject(socket, 400, `container ${container} is not valid for pod ${name}`)
    }
    if (!status.state?.running) {
      return reject(
        socket,
        400,
        `unable to upgrade connection: container not found ("${container}")`,
      )
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const image: string = status.image
      const command = url.searchParams.getAll('command')
      if (SHELLLESS.test(image)) {
        ws.send(
          frame(
            ERROR,
            JSON.stringify(
              failure(
                `OCI runtime exec failed: exec failed: unable to start container process: exec: "${command[0] === 'tar' ? 'tar' : 'sh'}": executable file not found in $PATH: unknown`,
              ),
            ),
          ),
        )
        ws.close()
        return
      }
      if (command[0] === 'tar' && files.run(ws, command, { namespace, pod: name, container })) {
        return
      }
      // An image without nsenter: the command's check says so.
      if (command.includes('nsenter') && /no-nsenter/.test(image)) {
        ws.send(
          frame(
            ERROR,
            JSON.stringify(
              failure(
                'command terminated with non-zero exit code: error executing command [env TERM=xterm-256color sh -c command -v nsenter], exit code 125',
                'NonZeroExitCode',
                { causes: [{ reason: 'ExitCode', message: '125' }] },
              ),
            ),
          ),
        )
        ws.close()
        return
      }
      // A node without a shell of its own (Talos): nsenter finds none there.
      const osImage: string = context.node(pod.spec.nodeName)?.status?.nodeInfo?.osImage ?? ''
      if (command.includes('nsenter') && /Talos/.test(osImage)) {
        ws.send(frame(STDOUT, "nsenter: can't execute 'sh': No such file or directory\r\n"))
        ws.send(
          frame(
            ERROR,
            JSON.stringify(
              failure(
                'command terminated with non-zero exit code: error executing command [env TERM=xterm-256color nsenter], exit code 127',
                'NonZeroExitCode',
                { causes: [{ reason: 'ExitCode', message: '127' }] },
              ),
            ),
          ),
        )
        ws.close()
        return
      }
      shells.add(ws)
      ws.on('close', () => shells.delete(ws))
      const session = shell(ws, pod, container, placeOf(pod, command))
      ws.on('message', (data: Buffer) => {
        if (data[0] === 0) session.input(data.subarray(1).toString())
        if (data[0] === RESIZE) {
          const { width, height } = JSON.parse(data.subarray(1).toString()) as {
            width: number
            height: number
          }
          session.resize(width, height)
        }
      })
    })
  }
  return {
    upgrade,
    shells: () => shells.size,
    tunnels: () => tunnels.size,
    files,
    /** Ends every open stream, e.g. when the cluster is reset. */
    closeAll: () => {
      for (const client of wss.clients) client.terminate()
    },
  }
}
