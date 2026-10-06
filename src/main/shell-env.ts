import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MARKER = '__LUMOVI_ENV__'

/**
 * What's taken from the login shell: PATH (where credential plugins are), and the proxy
 * kubectl and helm go through there, in either spelling.
 */
const FROM_SHELL = [
  'PATH',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
] as const

/**
 * Apps launched from the macOS Dock or a Linux desktop launcher don't inherit
 * what's set in the user's shell profile: the PATH where kubeconfig credential
 * plugins (gke-gcloud-auth-plugin, aws, kubelogin...) are, and the proxy
 * kubectl goes through. Ask the login shell once at startup. PATH replaces the
 * inherited one; a proxy setting is taken only where none is set already.
 * Windows GUI apps already get the user's environment.
 */
export async function loadLoginShellEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const shell = env.SHELL
  if (process.platform === 'win32' || !shell) return
  try {
    const { stdout } = await execFileAsync(
      shell,
      ['-ilc', FROM_SHELL.map((name) => `printf '${MARKER}%s' "$${name}"`).join('; ')],
      {
        timeout: 5_000,
        // Keep noisy shell frameworks quiet and prevent them from blocking on prompts.
        env: { ...env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true' },
      },
    )
    // What the profile printed before the first marker isn't ours.
    const values = stdout.split(MARKER).slice(1)
    if (values.length !== FROM_SHELL.length) return
    FROM_SHELL.forEach((name, i) => {
      const value = values[i]!
      if (!value) return
      if (name === 'PATH' || !env[name]) env[name] = value
    })
  } catch {
    // Keep the inherited environment if the shell is broken or slow.
  }
}
