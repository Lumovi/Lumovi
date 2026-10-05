/**
 * Terminals on this computer: your own shell, with kubectl (and helm, k9s…)
 * pointed at the cluster you're looking at, in that terminal only.
 *
 * Nothing secret is copied. A small kubeconfig of the terminal's own comes
 * first in its KUBECONFIG, before yours: kubectl takes the current context,
 * and a context's definition, from the first file that has them, so it uses
 * this cluster (and namespace), with the cluster's address and credentials
 * from your files. Tokens that credential plugins refresh land in your files,
 * and `kubectl config use-context` there changes this terminal only.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import type { LocalShellRequest, Result, ShellExit } from '@shared/api'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import { kubeconfigPaths, type KubeConfigStore } from '@backend/kube/kubeconfig'
import { assertQuery, assertString, invalid } from '@backend/kube/validate'

interface Session {
  pty: IPty
  /** The terminal's kubeconfig's folder, removed when it ends. */
  dir: string
}

/** The shell to start: yours (a login shell on macOS, as Terminal starts it), or PowerShell. */
export function localShell(env: NodeJS.ProcessEnv): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      file: join(env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo'],
    }
  }
  return {
    file: env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    args: process.platform === 'darwin' ? ['-l'] : [],
  }
}

/** A line of the terminal's own, before the shell's: dim, like a comment. */
const note = (text: string) => `\x1b[2m› ${text}\x1b[0m\r\n`

export class LocalTerminals {
  readonly #sessions = new Map<string, Session>()

  constructor(
    private readonly deps: {
      store: KubeConfigStore
      /** The login shell's PATH, once it's known. */
      envReady: Promise<void>
      env: NodeJS.ProcessEnv
      isReadOnly: (context: string) => boolean
      version: string
    },
    private readonly emit: {
      data: (id: string, data: string) => void
      exit: (id: string, exit: ShellExit) => void
    },
  ) {}

  /** Whether a request is for a terminal here, rather than in the cluster. */
  static handles(request: unknown): boolean {
    return (request as Partial<LocalShellRequest> | null)?.target === 'local'
  }

  async open(id: unknown, request: unknown): Promise<Result<null>> {
    try {
      if (typeof id !== 'string' || !/^[\w-]{8,64}$/.test(id) || this.#sessions.has(id)) {
        throw invalid('A new terminal needs a new id')
      }
      const r = assertQuery<LocalShellRequest>(request)
      assertString(r.context, 'context')
      if (r.namespace !== undefined) assertString(r.namespace, 'namespace')
      await this.deps.envReady
      const { env } = this.deps
      const context = this.deps.store.load().contexts.find((c) => c.name === r.context)
      if (!context) {
        throw new KubeRequestError(
          'invalid',
          `Your kubeconfig has no context called “${r.context}”.`,
        )
      }
      const shell = localShell(env)
      if (!existsSync(shell.file)) {
        throw new KubeRequestError(
          'invalid',
          `Your shell, ${shell.file}, isn’t there: set SHELL to one that is.`,
        )
      }
      const namespace = r.namespace ?? context.namespace
      const dir = mkdtempSync(join(tmpdir(), 'lumovi-terminal-'))
      const kubeconfig = join(dir, 'kubeconfig')
      writeFileSync(
        kubeconfig,
        JSON.stringify({
          apiVersion: 'v1',
          kind: 'Config',
          'current-context': context.name,
          contexts: [
            {
              name: context.name,
              context: { cluster: context.cluster, user: context.user, namespace },
            },
          ],
        }),
        { mode: 0o600 },
      )
      // Electron's own variables aren't the shell's.
      const inherited = Object.entries(env).filter(([key]) => !key.startsWith('ELECTRON_'))
      const pty = spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: homedir(),
        env: {
          // Apps opened from the Dock have no LANG, which shells and kubectl need for UTF-8.
          LANG: 'en_US.UTF-8',
          ...Object.fromEntries(inherited),
          KUBECONFIG: [kubeconfig, ...kubeconfigPaths(env)].join(delimiter),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'Lumovi',
          TERM_PROGRAM_VERSION: this.deps.version,
        },
      })
      this.#sessions.set(id, { pty, dir })
      this.emit.data(
        id,
        note(
          `kubectl points at ${context.name}${namespace ? `, namespace ${namespace},` : ''} in this terminal.${this.deps.isReadOnly(context.name) ? ' Lumovi’s read-only switch doesn’t apply to what you run here.' : ''}`,
        ),
      )
      pty.onData((data) => this.emit.data(id, data))
      pty.onExit(({ exitCode }) => {
        if (!this.#end(id)) return
        this.emit.exit(id, { code: exitCode })
      })
      return { ok: true, data: null }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  write(id: unknown, data: unknown): void {
    if (typeof data === 'string') this.#sessions.get(String(id))?.pty.write(data)
  }

  resize(id: unknown, columns: unknown, rows: unknown): void {
    if (Number.isInteger(columns) && Number.isInteger(rows)) {
      this.#sessions.get(String(id))?.pty.resize(columns as number, rows as number)
    }
  }

  /** Ends a terminal's shell (its page closed it). */
  close(id: unknown): void {
    const session = this.#sessions.get(String(id))
    if (!session) return
    this.#end(String(id))
    session.pty.kill()
  }

  closeAll(): void {
    for (const id of [...this.#sessions.keys()]) this.close(id)
  }

  /** Forgets a terminal and removes its kubeconfig; false when it ended already. */
  #end(id: string): boolean {
    const session = this.#sessions.get(id)
    if (!session) return false
    this.#sessions.delete(id)
    rmSync(session.dir, { recursive: true, force: true })
    return true
  }
}
