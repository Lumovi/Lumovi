/**
 * Terminals on this computer: your own shell, with kubectl (and helm, k9s…)
 * pointed at the cluster you're looking at, in that terminal only. The helm
 * Lumovi runs is last on its PATH, for when you have none of your own.
 *
 * Nothing secret is copied. A small kubeconfig of the terminal's own comes
 * first in its KUBECONFIG, before yours: kubectl takes the current context,
 * and a context's definition, from the first file that has them, so it uses
 * this cluster (and namespace), with the cluster's address and credentials
 * from your files. Tokens that credential plugins refresh land in your files,
 * and `kubectl config use-context` there changes this terminal only.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import type { LocalShellRequest, Result, ShellExit } from '@shared/api'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import type { KubeConfigStore } from '@backend/kube/kubeconfig'
import { assertQuery, assertString, invalid } from '@backend/kube/validate'
import type { MatchingKubectl } from './kubectl'

interface Session {
  pty: IPty
  /** The terminal's kubeconfig's folder, removed when it ends. */
  dir: string
}

/**
 * The startup files that put a folder (LUMOVI_KUBECTL's) first on a shell's PATH after yours
 * have run, as they may put their own first (macOS's path_helper does). Each runs yours as the
 * shell would, then hands back what it changed to get there.
 */
const STARTUP = {
  // zsh reads its files from ZDOTDIR: these, which read yours from yours (LUMOVI_ZDOTDIR, or
  // HOME), even when your .zshenv moves it, and give it back once the last has run.
  zsh: {
    '.zshenv': `lumovi_zdotdir=$ZDOTDIR
ZDOTDIR=\${LUMOVI_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv
LUMOVI_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$lumovi_zdotdir
`,
    '.zprofile': `if [[ -r $LUMOVI_ZDOTDIR/.zprofile ]]; then
  ZDOTDIR=$LUMOVI_ZDOTDIR; . $LUMOVI_ZDOTDIR/.zprofile; ZDOTDIR=$lumovi_zdotdir
fi
`,
    '.zshrc': `if [[ -r $LUMOVI_ZDOTDIR/.zshrc ]]; then
  ZDOTDIR=$LUMOVI_ZDOTDIR; . $LUMOVI_ZDOTDIR/.zshrc; ZDOTDIR=$lumovi_zdotdir
fi
path=($LUMOVI_KUBECTL \${path:#\${(b)LUMOVI_KUBECTL}})
[[ -o login ]] || . $lumovi_zdotdir/.lumovi-done
`,
    '.zlogin': `if [[ -r $LUMOVI_ZDOTDIR/.zlogin ]]; then
  ZDOTDIR=$LUMOVI_ZDOTDIR; . $LUMOVI_ZDOTDIR/.zlogin; ZDOTDIR=$lumovi_zdotdir
fi
path=($LUMOVI_KUBECTL \${path:#\${(b)LUMOVI_KUBECTL}})
. $lumovi_zdotdir/.lumovi-done
`,
    '.lumovi-done': `if [[ -n $LUMOVI_ZDOTDIR_UNSET && $LUMOVI_ZDOTDIR == $HOME ]]; then
  unset ZDOTDIR
else
  export ZDOTDIR=$LUMOVI_ZDOTDIR
fi
unset LUMOVI_ZDOTDIR LUMOVI_ZDOTDIR_UNSET LUMOVI_KUBECTL lumovi_zdotdir
`,
  },
  // bash, given this file to start with, reads none of its own: yours, as a login shell (on
  // macOS, as Terminal starts it) or another reads them.
  bash: {
    bashrc: `if [ -n "$LUMOVI_LOGIN" ]; then
  [ -r /etc/profile ] && . /etc/profile
  for lumovi_file in ~/.bash_profile ~/.bash_login ~/.profile; do
    if [ -r "$lumovi_file" ]; then . "$lumovi_file"; break; fi
  done
else
  [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
  [ -r ~/.bashrc ] && . ~/.bashrc
fi
case ":$PATH:" in ":$LUMOVI_KUBECTL:"*) ;; *) PATH="$LUMOVI_KUBECTL:$PATH" ;; esac
unset LUMOVI_LOGIN LUMOVI_KUBECTL lumovi_file
`,
  },
  // sh, dash, ksh and the like run ENV's file last: this, which runs yours.
  sh: {
    'env.sh': `if [ -n "$LUMOVI_ENV" ]; then ENV=$LUMOVI_ENV; [ -r "$ENV" ] && . "$ENV"; else unset ENV; fi
case ":$PATH:" in ":$LUMOVI_KUBECTL:"*) ;; *) PATH="$LUMOVI_KUBECTL:$PATH" ;; esac
unset LUMOVI_ENV LUMOVI_KUBECTL
`,
  },
}

/**
 * The shell to start: yours (a login shell on macOS, as Terminal starts it),
 * or PowerShell. PowerShell says the terminal's first line itself (`says`):
 * Windows' console host clears what's written before the shell starts.
 *
 * With `kubectl`, that folder is first on its PATH once your startup files have
 * run, by startup files of its own in `files` (or, for fish and PowerShell,
 * what it's started with). Other shells have it first as they start.
 */
export function localShell(
  env: NodeJS.ProcessEnv,
  first: string,
  kubectl?: { dir: string; files: string },
): { file: string; args: string[]; says: boolean; env: Record<string, string> } {
  const vars: Record<string, string> = kubectl ? { LUMOVI_KUBECTL: kubectl.dir } : {}
  if (process.platform === 'win32') {
    // Encoded, so that nothing in it (a context's name) is read as PowerShell; in its quotes,
    // each of PowerShell's single quotes (’ and ‘ are, too) doubled. After your profile.
    const quoted = first.replace(/['‘’‚‛]/g, (quote) => quote + quote)
    const script = `${kubectl ? "$env:Path = $env:LUMOVI_KUBECTL + ';' + $env:Path; Remove-Item Env:LUMOVI_KUBECTL; " : ''}Write-Host ('› ' + '${quoted}') -ForegroundColor DarkGray`
    return {
      file: join(env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: [
        '-NoLogo',
        '-NoExit',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      says: true,
      env: vars,
    }
  }
  const file = env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const login = process.platform === 'darwin'
  const args = login ? ['-l'] : []
  if (!kubectl) return { file, args, says: false, env: vars }
  const write = (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(kubectl.files, name), text, { mode: 0o600 })
    }
  }
  switch (basename(file)) {
    case 'zsh':
      write(STARTUP.zsh)
      return {
        file,
        args,
        says: false,
        env: {
          ...vars,
          ZDOTDIR: kubectl.files,
          LUMOVI_ZDOTDIR: env.ZDOTDIR ?? '',
          ...(env.ZDOTDIR === undefined && { LUMOVI_ZDOTDIR_UNSET: '1' }),
        },
      }
    case 'bash':
      write(STARTUP.bash)
      return {
        file,
        args: ['--init-file', join(kubectl.files, 'bashrc')],
        says: false,
        env: { ...vars, ...(login && { LUMOVI_LOGIN: '1' }) },
      }
    case 'fish':
      return {
        file,
        args: [
          ...args,
          '--init-command',
          'set -gx PATH $LUMOVI_KUBECTL $PATH; set -e LUMOVI_KUBECTL',
        ],
        says: false,
        env: vars,
      }
    default:
      write(STARTUP.sh)
      return {
        file,
        args,
        says: false,
        env: { ...vars, ENV: join(kubectl.files, 'env.sh'), LUMOVI_ENV: env.ENV ?? '' },
      }
  }
}

/**
 * Text for a terminal's own lines, which can carry what a cluster, a mirror or a kubeconfig
 * says: without control characters (a terminal would act on them: clear the screen, move the
 * cursor, write over Lumovi's words) or the marks that reorder text.
 */
const plain = (text: string) =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')

/** A line of the terminal's own, before the shell's: dim, like a comment. */
const note = (text: string) => `\x1b[2m› ${plain(text)}\x1b[0m\r\n`

/** Each terminal's kubeconfig is in a folder of its own: lumovi-terminal-<the app's pid>-…. */
const PREFIX = 'lumovi-terminal-'

/**
 * Deletes the kubeconfigs of terminals whose app is gone without deleting
 * them (it crashed, say): those of another Lumovi that runs stay.
 */
function sweep(): void {
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(new RegExp(`^${PREFIX}(\\d+)-`).exec(name)?.[1])
    if (pid && !running(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true })
  }
}

/** Whether a process runs (one of another user's can't be signalled, but runs). */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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
      /** The helm Lumovi runs (LUMOVI_HELM, or the one it ships with). */
      helm: () => string
      /** The kubectl matching a cluster, when terminals get one (`getting`: one's downloaded). */
      kubectl?: (
        context: string,
        getting: (version: string) => void,
      ) => Promise<MatchingKubectl> | undefined
    },
    private readonly emit: {
      data: (id: string, data: string) => void
      exit: (id: string, exit: ShellExit) => void
    },
  ) {
    sweep()
  }

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
      const namespace = r.namespace ?? context.namespace
      const kubectl = await this.deps.kubectl?.(context.name, (version) =>
        this.emit.data(id, note(`Getting kubectl ${version}, to match the cluster…`)),
      )
      const matching = kubectl && 'dir' in kubectl ? kubectl : undefined
      const first = [
        `kubectl points at ${context.name}${namespace ? `, namespace ${namespace},` : ''} in this terminal.`,
        ...(matching ? [`It’s ${matching.version}, to match the cluster.`] : []),
        ...(matching?.unsigned
          ? [
              `${matching.unsigned} has no Kubernetes signature for it, so Lumovi checked it against its SHA-256 only.`,
            ]
          : []),
        ...(kubectl && 'problem' in kubectl
          ? [`It’s the one on your PATH: ${kubectl.problem}.`]
          : []),
        ...(this.deps.isReadOnly(context.name)
          ? ['Lumovi’s read-only switch doesn’t apply to what you run here.']
          : []),
      ]
        .map(plain)
        .join(' ')
      const shellFile = localShell(env, first).file
      if (!existsSync(shellFile)) {
        throw new KubeRequestError(
          'invalid',
          `Your shell, ${shellFile}, isn’t there: set SHELL to one that is.`,
        )
      }
      const dir = mkdtempSync(join(tmpdir(), `${PREFIX}${process.pid}-`))
      const shell = localShell(env, first, matching && { dir: matching.dir, files: dir })
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
      // Windows spells it Path, and has only one.
      const PATH = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
      const helm = this.deps.helm()
      const pty = spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: homedir(),
        env: {
          // Apps opened from the Dock have no LANG, which shells and kubectl need for UTF-8.
          LANG: 'en_US.UTF-8',
          ...Object.fromEntries(inherited),
          // The kubectl matching the cluster first (as the shell starts, and after your startup
          // files), and the folder of the helm Lumovi runs last: yours first, where you have one.
          [PATH]: [matching?.dir, env[PATH], isAbsolute(helm) ? dirname(helm) : undefined]
            .filter(Boolean)
            .join(delimiter),
          ...shell.env,
          // Yours as Lumovi reads them (those chosen in it, or KUBECONFIG's): a relative one from
          // where it started, not the shell.
          KUBECONFIG: [
            kubeconfig,
            ...this.deps.store.paths().paths.map((path) => resolve(path)),
          ].join(delimiter),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          TERM_PROGRAM: 'Lumovi',
          TERM_PROGRAM_VERSION: this.deps.version,
        },
      })
      this.#sessions.set(id, { pty, dir })
      if (!shell.says) this.emit.data(id, note(first))
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
