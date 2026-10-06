/**
 * What a company's IT sets for every Lumovi on its computers (deployed with an MDM, Group
 * Policy, or configuration management), where only an administrator can write it, and locked
 * as it says:
 *
 *   macOS    /Library/Application Support/Lumovi/policy.json
 *   Linux    /etc/lumovi/policy.json
 *   Windows  the registry: HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Lumovi, its Policy value
 *            (REG_SZ), where Group Policy and Intune put policies
 *
 * On macOS and Linux the file, and its folder, must be root's and writable by nobody else, or
 * it can't be used. (LUMOVI_POLICY names a file to try one out, where IT has none: it never
 * takes the place of IT's.) It's JSON:
 *
 *   {
 *     "readOnly": true,                  every cluster read-only; or ["prod-*", "billing"]
 *     "assistants": false,               AI assistants can't be turned on
 *     "assistantRules": [ … ],           what they may do at most (as LUMOVI_ASSISTANT_RULES)
 *     "updates": false,                  Lumovi doesn't update itself: IT deploys new versions
 *     "network": {                       Lumovi's own connections
 *       "proxy": "http://proxy.corp.example.com:3128",
 *       "noProxy": ".corp.example.com",
 *       "caFiles": ["/Library/Application Support/Lumovi/corp-root.pem"]
 *     }
 *   }
 *
 * One that can't be used locks the most it could: every cluster read-only, and AI assistants
 * off, until it's put right.
 *
 * readOnly's names are kubeconfig contexts', which the person names: a list keeps them from
 * changing those clusters by mistake, `true` from changing any.
 *
 * It's what Lumovi does on the computer, not a wall against the person using it: their
 * kubeconfig's credentials are theirs to use with kubectl. What they may do to a cluster is
 * Kubernetes RBAC's to say.
 */
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import { checkedLimits, type AiRule } from '@shared/ai-permissions'
import type { ManagedSettings } from '@shared/api'

export interface Policy {
  /** What the page shows as set by the organization (none: there's no policy). */
  managed?: ManagedSettings
  /** What AI assistants may do at most. */
  assistantRules: AiRule[]
  /** Lumovi's own connections: through a proxy, and trusting these certificate authorities. */
  network: { proxy?: string; noProxy?: string; caFiles: string[] }
}

/** No policy: nothing set by an organization. */
export const NO_POLICY: Policy = { assistantRules: [], network: { caFiles: [] } }

/** Where IT puts the policy on macOS and Linux. */
const POLICY_FILE: Partial<Record<NodeJS.Platform, string>> = {
  darwin: '/Library/Application Support/Lumovi/policy.json',
  linux: '/etc/lumovi/policy.json',
}

/** Where IT puts it on Windows: a value of the registry's policies, only administrators' to set. */
export const POLICY_KEY = 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Lumovi'

const KEYS = ['readOnly', 'assistants', 'assistantRules', 'updates', 'network']
const NETWORK_KEYS = ['proxy', 'noProxy', 'caFiles']

/** A policy found: where, and its text (which throws, if it can't be used). */
interface Found {
  source: string
  text: () => string
}

/**
 * The organization's policy, if there is one; one that can't be used locks the most. IT's
 * comes first: a file LUMOVI_POLICY names is only tried where there's none.
 */
export function readPolicy(env: NodeJS.ProcessEnv = process.env): Policy {
  const found =
    (process.platform === 'win32' ? inRegistry(env) : administratorsFile()) ?? tryingOut(env)
  if (!found) return NO_POLICY
  try {
    const text = found.text()
    // A key given twice would be the last one's, quietly: said instead.
    const twice = parseDocument(text, { uniqueKeys: true }).errors.find(
      (error) => error.code === 'DUPLICATE_KEY',
    )
    if (twice) throw new Error(`a key is given twice: ${twice.message.split('\n')[0]}`)
    return checked(json(text), found.source)
  } catch (error) {
    const problem = `${found.source} can’t be used: ${(error as Error).message}`
    return {
      managed: { source: found.source, readOnly: true, assistantsOff: true, problem },
      assistantRules: [],
      network: { caFiles: [] },
    }
  }
}

/** The policy's JSON; where it isn't, where not, never what's there (a proxy's credentials). */
function json(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const { message } = error as Error
    const where = /line \d+ column \d+/.exec(message) ?? /position \d+/.exec(message)
    throw new Error(`it isn’t JSON${where ? ` (at ${where[0]})` : ''}.`, { cause: error })
  }
}

/** A file to try a policy out with, where IT has none. */
function tryingOut(env: NodeJS.ProcessEnv): Found | undefined {
  const path = env.LUMOVI_POLICY
  if (!path || !present(path)) return undefined
  return { source: path, text: () => readOpen(path) }
}

/**
 * IT's file, on macOS and Linux: used only if it, and its folder, are root's and writable by
 * nobody else; checked as it's read (the same open file), so it can't be swapped in between.
 */
function administratorsFile(): Found | undefined {
  const path = POLICY_FILE[process.platform]
  if (!path || !present(path)) return undefined
  return {
    source: path,
    text: () => {
      // Its folder, and, where it's a link, its target's.
      for (const folder of new Set([dirname(path), dirname(realpathSync(path))])) {
        administrators(folder, statSync(folder))
      }
      return readOpen(path, (stats) => administrators(path, stats))
    },
  }
}

/**
 * Whether there's something at a path: nothing is no policy, but what can't be looked at (a
 * folder it can't search) is one that can't be used, not none.
 */
function present(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

/**
 * A policy file's text, read from the file opened once (and checked as it is, first): never
 * waiting on what isn't a file (a FIFO, a device).
 */
function readOpen(path: string, check?: (stats: Stats) => void): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) throw new Error(`${path} must be a file.`)
    check?.(stats)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** Throws unless only root could have written it. */
function administrators(path: string, { uid, mode }: { uid: number; mode: number }): void {
  if (uid !== 0 || (mode & 0o022) !== 0) {
    throw new Error(
      `${path} must be root’s, and writable by nobody else (it’s user ${uid}’s, mode ${(mode & 0o777).toString(8)}).`,
    )
  }
}

/** Windows' own programs, where an environment variable can't move them; elsewhere, where it says. */
function windowsProgram(env: NodeJS.ProcessEnv, path: string): string {
  const where = [
    join('C:\\Windows\\System32', path),
    join(env.SystemRoot ?? 'C:\\Windows', 'System32', path),
  ]
  return where.find((candidate) => existsSync(candidate)) ?? where[0]!
}

/** A program's output, and how it ended: never throws. */
function run(
  program: string,
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
): { status: number | null; out: string } {
  try {
    const out = execFileSync(program, args, {
      ...options,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { status: 0, out }
  } catch (error) {
    return { status: (error as { status?: number | null }).status ?? null, out: '' }
  }
}

/**
 * IT's policy on Windows, if it's set: the registry's. reg.exe reads it (from Windows' own
 * folder, not one PATH finds); where it can't, it's only no policy if the key isn't there:
 * as reg.exe lists the key's parent, or, where reg.exe can't read the registry at all (as
 * "Prevent access to registry editing tools" has it), as PowerShell's registry provider,
 * which that doesn't stop, says. PowerShell reads it, too, where reg.exe can't, or garbles it
 * (it writes in the console's code page). Anything else locks the most.
 */
export function inRegistry(
  env: NodeJS.ProcessEnv,
  key = POLICY_KEY,
  programs = {
    reg: windowsProgram(env, 'reg.exe'),
    powershell: windowsProgram(env, 'WindowsPowerShell\\v1.0\\powershell.exe'),
  },
): Found | undefined {
  const source = `${key}\\Policy`
  /** PowerShell's reading; `there` where reg.exe has seen the key, so it's never none. */
  const read = (there: boolean): Found | undefined => {
    // Its own modules, never ones another folder in PSModulePath has under the same name.
    const modules = join(dirname(programs.powershell), 'Modules')
    const { status, out } = run(
      programs.powershell,
      ['-NoProfile', '-NonInteractive', '-Command', powershellRead(key)],
      { timeout: 10_000, env: { ...env, PSModulePath: modules } },
    )
    if (status === 3 && !there) return undefined
    return {
      source,
      text: () => {
        if (status === 0) return out.trimEnd()
        throw new Error(
          status === 4
            ? 'it must be text (REG_SZ): the policy’s JSON.'
            : 'Lumovi can’t read it: neither reg.exe nor PowerShell could.',
        )
      },
    }
  }
  const quick = { timeout: 5_000 }
  const value = run(programs.reg, ['query', key, '/v', 'Policy', '/reg:64'], quick)
  if (value.status === 0) {
    // What isn't ASCII, PowerShell reads as it is.
    return value.out.includes('\uFFFD')
      ? read(true)
      : { source, text: () => registryValue(value.out) }
  }
  // Not read: there's no such key, or it can't be read, which reg.exe says alike.
  const parent = run(programs.reg, ['query', key.slice(0, key.lastIndexOf('\\')), '/reg:64'], quick)
  if (parent.status === 0) {
    const there = parent.out
      .split(/\r?\n/)
      .some((line) => line.trim().toLowerCase() === key.toLowerCase())
    return there ? read(true) : undefined
  }
  // reg.exe can't read the registry at all: PowerShell says whether the key's there.
  return read(false)
}

/**
 * PowerShell that writes the key's Policy value, what isn't ASCII as JSON's escapes, and
 * ends 3 where there's no such key, 4 where it has no text: in what Constrained Language
 * Mode allows.
 */
function powershellRead(key: string): string {
  return [
    // From where PowerShell is, whatever PSModulePath says.
    "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Management')",
    `$key = 'Registry::${key.replaceAll("'", "''")}'`,
    'if (-not (Test-Path -LiteralPath $key)) { exit 3 }',
    '$value = (Get-ItemProperty -LiteralPath $key -Name Policy -ErrorAction SilentlyContinue).Policy',
    'if ($value -isnot [string]) { exit 4 }',
    "$out = ''",
    "foreach ($c in $value.ToCharArray()) { if ([int]$c -gt 126) { $out += '\\u{0:x4}' -f [int]$c } else { $out += $c } }",
    'Write-Output $out',
    'exit 0',
  ].join('; ')
}

/** The Policy value as reg.exe prints it: to the end, as its JSON may have lines of its own. */
function registryValue(out: string): string {
  const value = /^ {4}Policy {4}REG_(\w+) {4}/m.exec(out)
  if (!value || !['SZ', 'EXPAND_SZ', 'MULTI_SZ'].includes(value[1]!)) {
    throw new Error('it must be text (REG_SZ): the policy’s JSON.')
  }
  const text = out.slice(value.index + value[0].length).trimEnd()
  // A list of strings comes as one, separated by \0.
  return value[1] === 'MULTI_SZ' ? text.replaceAll('\\0', '\n') : text
}

/** A policy as it was given, checked: anything it doesn't take is said, not ignored. */
function checked(given: unknown, path: string): Policy {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    throw new Error('it must be a JSON object.')
  }
  const policy = given as Record<string, unknown>
  const unknown = Object.keys(policy).filter((key) => !KEYS.includes(key))
  if (unknown.length) {
    throw new Error(`it has ${unknown.join(', ')}, which Lumovi doesn’t know: ${KEYS.join(', ')}.`)
  }
  const { readOnly, assistants, assistantRules, updates, network = {} } = policy
  if (
    readOnly !== undefined &&
    typeof readOnly !== 'boolean' &&
    !(Array.isArray(readOnly) && readOnly.every((name) => typeof name === 'string' && name))
  ) {
    throw new Error('readOnly must be true, false, or a list of cluster names (with * for any).')
  }
  for (const [key, value] of [
    ['assistants', assistants],
    ['updates', updates],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${key} must be true or false.`)
    }
  }
  if (typeof network !== 'object' || network === null || Array.isArray(network)) {
    throw new Error('network must be an object: proxy, noProxy and caFiles.')
  }
  const net = network as Record<string, unknown>
  const unknownNet = Object.keys(net).filter((key) => !NETWORK_KEYS.includes(key))
  if (unknownNet.length) {
    throw new Error(`network has ${unknownNet.join(', ')}: it takes ${NETWORK_KEYS.join(', ')}.`)
  }
  if (
    net.proxy !== undefined &&
    (typeof net.proxy !== 'string' || !/^https?:\/\//i.test(net.proxy))
  ) {
    throw new Error('network.proxy must be the proxy’s http or https URL.')
  }
  if (net.noProxy !== undefined && typeof net.noProxy !== 'string') {
    throw new Error('network.noProxy must be text, as NO_PROXY is: names and addresses.')
  }
  const caFiles = net.caFiles ?? []
  if (!Array.isArray(caFiles) || !caFiles.every((file) => typeof file === 'string' && file)) {
    throw new Error('network.caFiles must be a list of files.')
  }
  const managed: ManagedSettings = {
    source: path,
    ...(readOnly === true ? { readOnly: true } : {}),
    ...(Array.isArray(readOnly) && readOnly.length ? { readOnly: readOnly as string[] } : {}),
    ...(assistants === false ? { assistantsOff: true } : {}),
    ...(updates === false ? { updatesOff: true } : {}),
  }
  return {
    managed,
    assistantRules:
      assistantRules === undefined ? [] : checkedLimits(assistantRules, 'assistantRules'),
    network: {
      ...(net.proxy ? { proxy: net.proxy as string } : {}),
      ...(net.noProxy ? { noProxy: net.noProxy as string } : {}),
      caFiles: caFiles as string[],
    },
  }
}
