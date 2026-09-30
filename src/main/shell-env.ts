import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MARKER = '__KUBESTACKS_PATH__'

/**
 * Apps launched from the macOS Dock or a Linux desktop launcher don't inherit
 * the PATH configured in the user's shell profile, so kubeconfig credential
 * plugins (gke-gcloud-auth-plugin, aws, kubelogin...) can't be found. Ask the
 * login shell for its PATH once at startup. Windows GUI apps already get the
 * full user PATH.
 */
export async function loadLoginShellPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const shell = env.SHELL
  if (process.platform === 'win32' || !shell) return
  try {
    const { stdout } = await execFileAsync(
      shell,
      ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`],
      {
        timeout: 5_000,
        // Keep noisy shell frameworks quiet and prevent them from blocking on prompts.
        env: { ...env, DISABLE_AUTO_UPDATE: 'true', ZSH_TMUX_AUTOSTARTED: 'true' },
      },
    )
    const path = stdout.split(MARKER)[1]
    if (path) env.PATH = path
  } catch {
    // Keep the inherited PATH if the shell is broken or slow.
  }
}
