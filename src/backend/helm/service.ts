/**
 * Helm releases: read from the cluster, and changed with the user's own helm
 * so changes behave exactly as Helm's do (hooks, three-way merges, its record
 * of revisions). KUBESTACKS_HELM names the helm to run; otherwise it's helm on
 * the login shell's PATH (or, on the server, the one in its image).
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parse, stringify } from 'yaml'
import type {
  ChartSearchResult,
  ChartSource,
  HelmCli,
  HelmDeploy,
  HelmDeployed,
  HelmRelease,
  HelmReleaseDetail,
  HelmRollback,
  HelmUninstall,
  LintResult,
  LocalChart,
  Result,
} from '@shared/api'
import { KubeRequestError, toKubeError } from '../kube/errors'
import type { KubeService } from '../kube/service'
import {
  assertIntegerInRange,
  assertQuery,
  assertString,
  invalid,
  optionalString,
} from '../kube/validate'
import { listReleases, releaseHistory, type StoredRelease } from './releases'

/** Installs and upgrades can take a while (hooks, image pulls with --wait in charts' hooks). */
const RUN_TIMEOUT_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 20_000
const MAX_VALUES = 1024 * 1024
/** Release names, like namespaces: DNS labels (Helm allows at most 53 characters). */
const NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
/** A chart's name in a repository's index. */
const CHART_NAME = /^[\w.-]+$/
/** What a .cmd or .bat wrapper may be given: the shell it runs in reads anything else. */
// No % either: cmd.exe expands %VARIABLES% even inside arguments.
const PLAIN = /^[\w@+=:,./\\~-]+$/
/** What the environment can change. */
const DEFAULTS = {
  KUBESTACKS_HELM: 'helm',
  KUBESTACKS_ARTIFACT_HUB_URL: 'https://artifacthub.io',
}

/** How helm reaches a cluster: what to add to its command line and environment. */
export interface HelmTarget {
  args: string[]
  env?: NodeJS.ProcessEnv
  /** Cleans up once helm is done, e.g. removes a kubeconfig written for it. */
  done?: () => Promise<void>
}

export interface HelmOptions {
  /** Resolves once the environment (login shell PATH) is ready to run helm. */
  envReady: Promise<void>
  /** Whether a context is read-only; changes to it are refused. */
  isReadOnly: (context: string) => boolean
  /** The user's kubeconfig context, unless set otherwise. */
  target?: (context: string) => Promise<HelmTarget>
  /** Whether charts can come from files, as on the desktop (a server only takes remote ones). */
  localCharts: boolean
  /** Refuses URLs charts mustn't be fetched from (see the server's network policy). */
  checkUrl?: (url: string) => Promise<void>
}

/** On the desktop: the context in the user's kubeconfig. */
const kubeContext = async (context: string): Promise<HelmTarget> => ({
  args: ['--kube-context', context],
})

export class HelmService {
  private readonly envReady: Promise<void>
  private readonly isReadOnly: (context: string) => boolean
  private readonly env = process.env
  readonly #target: (context: string) => Promise<HelmTarget>
  readonly #localCharts: boolean
  readonly #checkUrl: (url: string) => Promise<void>

  constructor(
    private readonly kube: KubeService,
    options: HelmOptions,
  ) {
    this.envReady = options.envReady
    this.isReadOnly = options.isReadOnly
    this.#target = options.target ?? kubeContext
    this.#localCharts = options.localCharts
    this.#checkUrl = options.checkUrl ?? (async () => undefined)
  }

  get #command(): string {
    return this.#setting('KUBESTACKS_HELM')
  }

  #setting(name: keyof typeof DEFAULTS): string {
    return { ...DEFAULTS, ...this.env }[name]!
  }

  releases(context: unknown, namespace?: unknown): Promise<Result<HelmRelease[]>> {
    return this.#result(() => {
      assertString(context, 'context')
      optionalString(namespace, 'namespace')
      return listReleases(this.#list(context), namespace as string | undefined)
    })
  }

  release(context: unknown, namespace: unknown, name: unknown): Promise<Result<HelmReleaseDetail>> {
    return this.#result(async () => {
      assertString(context, 'context')
      assertName(namespace, 'namespace')
      assertName(name, 'name')
      return (await releaseHistory(this.#list(context), namespace, name)).detail
    })
  }

  /** Whether helm runs, and which. */
  async cli(): Promise<HelmCli> {
    try {
      const version = await this.#helm(['version', '--short'])
      return { available: true, command: this.#command, version: version.trim() }
    } catch {
      return { available: false, command: this.#command }
    }
  }

  rollback(request: unknown): Promise<Result<null>> {
    return this.#result(async () => {
      const r = assertQuery<HelmRollback>(request)
      this.#assertChangeable(r)
      assertIntegerInRange(r.revision, 'revision', 1, 1_000_000)
      await this.#onCluster(r.context, (args, env) =>
        this.#helm(
          ['rollback', r.name, String(r.revision), '--namespace', r.namespace, ...args],
          env,
        ),
      )
      return null
    })
  }

  uninstall(request: unknown): Promise<Result<null>> {
    return this.#result(async () => {
      const r = assertQuery<HelmUninstall>(request)
      this.#assertChangeable(r)
      await this.#onCluster(r.context, (args, env) =>
        this.#helm(
          [
            'uninstall',
            r.name,
            '--namespace',
            r.namespace,
            ...args,
            ...(r.keepHistory === true ? ['--keep-history'] : []),
          ],
          env,
        ),
      )
      return null
    })
  }

  /**
   * Upgrades a release, or installs one, with all the values the user sets.
   * A dry run asks the API server and changes nothing.
   */
  deploy(request: unknown): Promise<Result<HelmDeployed>> {
    return this.#result(async () => {
      const r = assertQuery<HelmDeploy>(request)
      this.#assertChangeable(r)
      // No values at all is fine: the chart's defaults apply.
      if (typeof r.values !== 'string') throw invalid('values must be a string')
      if (r.values.length > MAX_VALUES) throw invalid('The values are too large')
      const directory = await mkdtemp(join(tmpdir(), 'kubestacks-helm-'))
      try {
        const values = join(directory, 'values.yaml')
        await writeFile(values, r.values)
        let chart: string[]
        if (r.source === 'stored') {
          // The chart the release runs is stored with it, but without its subcharts.
          const { latest } = await releaseHistory(this.#list(r.context), r.namespace, r.name)
          if (latest.chart.metadata.dependencies?.length) {
            throw invalid(
              `${r.name}’s chart has subcharts, which Helm doesn’t keep with the release. Choose the chart to upgrade with.`,
            )
          }
          chart = [await writeChart(latest.chart, join(directory, 'chart'))]
        } else {
          chart = await this.#sourceArgs(r.source)
        }
        const output = await this.#onCluster(r.context, (args, env) =>
          this.#helm(
            [
              r.install === true ? 'install' : 'upgrade',
              r.name,
              ...chart,
              '--namespace',
              r.namespace,
              ...args,
              '--values',
              values,
              '--output',
              'json',
              ...(r.install === true && r.createNamespace === true ? ['--create-namespace'] : []),
              ...(r.dryRun === true ? ['--dry-run=server'] : []),
            ],
            env,
          ),
        )
        const deployed = JSON.parse(output) as StoredRelease
        return {
          revision: deployed.version,
          manifest: deployed.manifest,
          notes: deployed.info.notes,
        }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  /** A chart's default values, as its values.yaml has them. */
  defaults(source: unknown): Promise<Result<string>> {
    return this.#result(async () =>
      this.#helm(['show', 'values', ...(await this.#sourceArgs(source))]),
    )
  }

  /** The versions a chart repository lists of a chart, as its index orders them (newest first). */
  versions(repository: unknown, chart: unknown): Promise<Result<string[]>> {
    return this.#result(async () => {
      assertUrl(repository, 'repository')
      assertString(chart, 'chart')
      await this.#checkUrl(repository)
      const index = parse(await fetchText(`${repository.replace(/\/+$/, '')}/index.yaml`)) as {
        entries?: Record<string, { version: string }[]>
      }
      const entries = index.entries?.[chart]
      if (!entries)
        throw new KubeRequestError('not-found', `${repository} has no chart named ${chart}.`)
      return entries.map((entry) => entry.version)
    })
  }

  /** Helm charts on Artifact Hub (or the one in KUBESTACKS_ARTIFACT_HUB_URL). */
  search(query: unknown): Promise<Result<ChartSearchResult[]>> {
    return this.#result(async () => {
      assertString(query, 'query')
      const hub = this.#setting('KUBESTACKS_ARTIFACT_HUB_URL')
      const params = new URLSearchParams({ ts_query_web: query, kind: '0', limit: '20' })
      const { packages } = JSON.parse(
        await fetchText(`${hub}/api/v1/packages/search?${params}`),
      ) as {
        packages: {
          name: string
          version: string
          app_version?: string
          description?: string
          repository: { name: string; url: string }
        }[]
      }
      return packages.map((p) => ({
        name: p.name,
        version: p.version,
        appVersion: p.app_version,
        description: p.description,
        repository: { name: p.repository.name, url: p.repository.url },
      }))
    })
  }

  /** What a chart on this computer is (`helm show chart`), and what it needs. */
  local(path: unknown): Promise<Result<LocalChart>> {
    return this.#result(async () => {
      const at = await chartPath(path)
      const archive = !(await stat(at)).isDirectory()
      const chart = parse(await this.#helm(['show', 'chart', at])) as {
        name: string
        version: string
        appVersion?: string
        description?: string
        dependencies?: unknown[]
      }
      return {
        path: at,
        archive,
        name: chart.name,
        version: String(chart.version),
        appVersion: chart.appVersion,
        description: chart.description,
        dependencies: chart.dependencies?.length
          ? dependencyList(await this.#helm(['dependency', 'list', at]))
          : [],
        valuesFiles: archive ? [] : await valuesFiles(at),
      }
    })
  }

  /** `helm lint` with these values: what it found, errors first. */
  lint(path: unknown, values: unknown): Promise<Result<LintResult>> {
    return this.#result(async () => {
      const at = await chartPath(path)
      if (typeof values !== 'string') throw invalid('values must be a string')
      const directory = await mkdtemp(join(tmpdir(), 'kubestacks-lint-'))
      try {
        await writeFile(join(directory, 'values.yaml'), values)
        const run = await this.#run(['lint', at, '--values', join(directory, 'values.yaml')])
        const messages = lintMessages(run.stdout)
        // It fails when it finds errors; failing without any is helm failing.
        if (run.code !== 0 && !messages.some((m) => m.severity === 'error')) throw helmError(run)
        return { passed: run.code === 0, messages }
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  /** One of the values files beside a local chart. */
  valuesFile(path: unknown, file: unknown): Promise<Result<string>> {
    return this.#result(async () => {
      const at = await chartPath(path)
      if (!(await valuesFiles(at)).includes(file as string)) {
        throw invalid(`${String(file)} isn’t one of ${basename(at)}’s values files`)
      }
      return readFile(join(at, file as string), 'utf8')
    })
  }

  /** `helm dependency update`: downloads a chart folder's subcharts into its charts/ folder. */
  updateDependencies(path: unknown): Promise<Result<null>> {
    return this.#result(async () => {
      const at = await chartPath(path)
      if (!(await stat(at)).isDirectory()) {
        throw invalid('A packaged chart has its dependencies already; this updates chart folders')
      }
      await this.#helm(['dependency', 'update', at])
      return null
    })
  }

  /** What helm takes to find a chart: never an option in disguise, nor a file a server has. */
  async #sourceArgs(source: unknown): Promise<string[]> {
    const s = assertQuery<ChartSource>(source)
    assertString(s.chart, 'chart')
    if (s.chart.startsWith('-')) throw invalid('chart can’t start with a dash')
    if (s.repository !== undefined) assertUrl(s.repository, 'repository')
    optionalString(s.version, 'version')
    if (s.version?.startsWith('-')) throw invalid('version can’t start with a dash')
    const remote = /^(oci|https?):\/\//.test(s.chart)
    if (!this.#localCharts) {
      // Only a chart in a repository, a registry or at a URL: never a path on the server.
      if (s.repository ? !CHART_NAME.test(s.chart) : !remote) {
        throw invalid(
          'Choose a chart from a repository (its name and the repository’s URL), an oci:// registry or a URL.',
        )
      }
    }
    if (s.repository) await this.#checkUrl(s.repository)
    else if (remote) await this.#checkUrl(s.chart.replace(/^oci:/, 'https:'))
    return [
      this.#localCharts ? expandHome(s.chart) : s.chart,
      ...(s.repository ? ['--repo', s.repository] : []),
      ...(s.version ? ['--version', s.version] : []),
    ]
  }

  /** Runs `task` with the flags (and environment) that point helm at `context`. */
  async #onCluster<T>(
    context: string,
    task: (args: string[], env?: NodeJS.ProcessEnv) => Promise<T>,
  ): Promise<T> {
    const target = await this.#target(context)
    try {
      return await task(target.args, target.env)
    } finally {
      await target.done?.()
    }
  }

  #list(context: string) {
    return (path: string, selector: string) => this.kube.listRaw(context, path, selector)
  }

  #assertChangeable(r: { context: unknown; namespace: unknown; name: unknown }): void {
    assertString(r.context, 'context')
    assertName(r.namespace, 'namespace')
    assertName(r.name, 'name')
    if (this.isReadOnly(r.context)) {
      throw new KubeRequestError(
        'read-only',
        `${r.context} is read-only in KubeStacks. Allow changes to it to continue.`,
      )
    }
  }

  /** Runs helm, resolving with what it printed, or rejecting with what it said went wrong. */
  async #helm(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const run = await this.#run(args, env)
    if (run.code !== 0) throw helmError(run)
    return run.stdout
  }

  /** Runs helm, resolving with how it ended and what it printed. */
  async #run(args: string[], env?: NodeJS.ProcessEnv): Promise<HelmRun> {
    await this.envReady
    const command = this.#command
    // A .cmd or .bat wrapper (on Windows) only runs through the shell.
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
    if (shell && !args.every((arg) => PLAIN.test(arg))) {
      throw new KubeRequestError(
        'helm',
        `${command} is a script, and can’t be given ${args.join(' ')}.`,
      )
    }
    return new Promise((done, fail) => {
      const child = spawn(command, args, {
        env: { ...this.env, ...env },
        shell,
        windowsHide: true,
        timeout: RUN_TIMEOUT_MS,
      })
      let stdout = ''
      let stderr = ''
      // Decoded as a stream, so a character split across chunks stays whole.
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
      child.on('error', () =>
        fail(
          new KubeRequestError(
            'helm',
            `KubeStacks uses helm for this, and couldn’t run ${command}. Install Helm (https://helm.sh), or set KUBESTACKS_HELM to where it is.`,
          ),
        ),
      )
      // No code when it was stopped, e.g. after RUN_TIMEOUT_MS.
      child.on('close', (code, signal) => done({ code: code ?? -1, signal, stdout, stderr }))
    })
  }

  async #result<T>(task: () => Promise<T>): Promise<Result<T>> {
    try {
      return { ok: true, data: await task() }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }
}

function assertName(value: unknown, field: string): asserts value is string {
  assertString(value, field)
  if (value.length > 63 || !NAME.test(value)) {
    throw invalid(`${field} must be lowercase letters, digits and dashes`)
  }
}

function assertUrl(value: unknown, field: string): asserts value is string {
  assertString(value, field)
  if (!/^https?:\/\/\S+$/.test(value)) throw invalid(`${field} must be an http or https URL`)
}

/** What helm said went wrong. */
interface HelmRun {
  code: number
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function helmError(run: HelmRun): KubeRequestError {
  const said = (run.stderr || run.stdout).trim().replace(/^Error: /, '')
  return new KubeRequestError(
    'helm',
    said ||
      (run.signal
        ? `helm was stopped (${run.signal}) before it finished.`
        : `helm failed (exit code ${run.code}) without saying why.`),
  )
}

/** `~/charts/web` as the full path it means. */
const expandHome = (path: string) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path)

/** A chart on this computer by its full path (or one from ~): there, and a chart. */
async function chartPath(value: unknown): Promise<string> {
  assertString(value, 'path')
  const path = expandHome(value)
  if (!isAbsolute(path)) throw invalid('Give the chart’s full path, or choose it')
  const info = await stat(path).catch(() => {
    throw new KubeRequestError('not-found', `Nothing is at ${path}.`)
  })
  if (info.isDirectory()) {
    const chart = await stat(join(path, 'Chart.yaml')).catch(() => null)
    if (!chart) throw invalid(`${path} has no Chart.yaml, so it isn’t a chart.`)
  } else if (!/\.tgz$/i.test(path)) {
    throw invalid(`${basename(path)} isn’t a packaged chart (.tgz).`)
  }
  return path
}

const YAML_FILE = /\.ya?ml$/i
const NOT_VALUES = new Set(['Chart.yaml', 'values.yaml'])

/** Values files beside a chart's own: values-prod.yaml, and its ci/ folder's (as helm's own tests use). */
async function valuesFiles(folder: string): Promise<string[]> {
  const root = (await readdir(folder)).filter((n) => YAML_FILE.test(n) && !NOT_VALUES.has(n))
  const ci = await readdir(join(folder, 'ci')).catch((): string[] => [])
  return [...root, ...ci.filter((n) => YAML_FILE.test(n)).map((n) => `ci/${n}`)].sort()
}

/** `helm dependency list`'s table: a row of tab-separated cells per subchart, after its header. */
function dependencyList(output: string): LocalChart['dependencies'] {
  return output
    .split('\n')
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const [name, version, repository, status] = line.split('\t').map((cell) => cell.trim())
      return { name: name!, version: version!, repository: repository!, status: status! }
    })
}

const LINT_LINE = /^\[(INFO|WARNING|ERROR)\] (.*)$/
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 }

/** `helm lint`'s findings, errors first; a finding can go on over indented lines. */
function lintMessages(output: string): LintResult['messages'] {
  const messages: LintResult['messages'] = []
  for (const line of output.split('\n')) {
    const found = LINT_LINE.exec(line)
    if (found) {
      const severity = found[1]!.toLowerCase() as LintResult['messages'][number]['severity']
      messages.push({ severity, text: found[2]! })
    } else if (/^\s+\S/.test(line)) {
      messages.at(-1)!.text += `\n${line.trim()}`
    }
  }
  return messages.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

/** Writes a chart as a release stores it (without subcharts) to a folder helm can use. */
async function writeChart(chart: StoredRelease['chart'], directory: string): Promise<string> {
  const files: [string, string | Buffer][] = [
    ['Chart.yaml', stringify(chart.metadata)],
    ['values.yaml', stringify(chart.values ?? {})],
    ...(chart.schema
      ? ([['values.schema.json', Buffer.from(chart.schema, 'base64')]] as [string, Buffer][])
      : []),
    ...[...(chart.templates ?? []), ...(chart.files ?? [])].map((file): [string, Buffer] => [
      file.name,
      Buffer.from(file.data, 'base64'),
    ]),
  ]
  for (const [name, content] of files) {
    const path = resolve(directory, name)
    if (!path.startsWith(directory + sep)) {
      throw invalid(`The stored chart has a file outside its folder: ${name}`)
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return directory
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(
    (error: Error) => {
      throw new KubeRequestError('unreachable', `Couldn’t reach ${url}: ${error.message}`)
    },
  )
  if (!response.ok) {
    throw new KubeRequestError(
      'not-found',
      `${url} answered ${response.status} ${response.statusText}`,
    )
  }
  return response.text()
}
