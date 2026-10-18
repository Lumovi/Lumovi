/**
 * A person's EKS clusters, found with their own `aws` CLI (the desktop app's Add a cluster → From
 * AWS), only as they ask: as them, read-only (sts get-caller-identity, eks list-clusters and
 * describe-cluster), never asking anything (no stdin, no pager, 30 seconds at most), and with
 * no key of the environment's in the way of the profile they chose. Lumovi reads nothing of
 * ~/.aws itself and keeps no credential: what's found is a kubeconfig of the shape `aws eks
 * update-kubeconfig` writes, whose command signs in, added as any other once it's agreed to.
 */
import { spawn } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { stringify } from 'yaml'
import type { AwsCluster, AwsFound, ManagedSettings, Result } from '@shared/api'
import { KubeRequestError, toKubeError } from '@backend/kube/errors'
import { lockedBy } from './kubeconfig-files'

/** How long one run of `aws` may take: past it, it's stopped. */
const RUN_MS = 30_000
/** What one run may print, at most. */
const MOST_BYTES = 4 * 1024 * 1024
/**
 * Keys of the environment's own, which would sign in instead of the profile chosen. (botocore's
 * chain also takes a web identity, AWS_ROLE_ARN with AWS_WEB_IDENTITY_TOKEN_FILE, and a
 * container's credentials from the environment: rare on a person's computer, and left as set.)
 */
const KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const

/** An EKS cluster's name, as EKS gives them: none other goes into a command. */
const NAME = /^[0-9A-Za-z][A-Za-z0-9_-]{0,99}$/
/** A region, as AWS writes them: eu-west-1, us-gov-east-1, eusc-de-east-1. */
const REGION = /^[a-z]{2,4}(-[a-z]+)+-\d+$/
/** A profile's name: anything on one line, without an `=`. */
const profileOk = (name: string) => name !== '' && name.length <= 128 && !/[\r\n=]/.test(name)

/** What `aws` says when it can't, in Lumovi's words. */
class AwsProblem extends Error {}

export interface AwsClustersDeps {
  env: NodeJS.ProcessEnv
  managed?: ManagedSettings
}

export class AwsClusters {
  constructor(private readonly deps: AwsClustersDeps) {}

  /** The profiles `aws` knows, and the region each is set to, where it's set. */
  async profiles(): Promise<Result<{ profiles: string[]; regions: Record<string, string> }>> {
    try {
      this.#mayAdd()
      const listed = await this.#run(['configure', 'list-profiles'])
      const profiles = listed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(profileOk)
      const regions: Record<string, string> = {}
      for (const profile of profiles) {
        const region = (
          await this.#run(['configure', 'get', 'region'], profile).catch(() => '')
        ).trim()
        if (REGION.test(region)) regions[profile] = region
      }
      return { ok: true, data: { profiles, regions } }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  /** The clusters each profile has in each of its regions: what each is, or why not. */
  async find(asks: { profile: string; regions: string[] }[]): Promise<Result<AwsFound[]>> {
    try {
      this.#mayAdd()
      const found: AwsFound[] = []
      for (const { profile, regions } of asks) {
        if (!profileOk(profile)) continue
        for (const region of regions) {
          if (!REGION.test(region)) {
            found.push({ profile, region, clusters: [], problem: `${region} isn’t a region.` })
            continue
          }
          found.push(await this.#findIn(profile, region))
        }
      }
      return { ok: true, data: found }
    } catch (error) {
      return { ok: false, error: toKubeError(error) }
    }
  }

  async #findIn(profile: string, region: string): Promise<AwsFound> {
    let account: string | undefined
    try {
      const identity = answerOf(
        await this.#run(['sts', 'get-caller-identity', '--region', region], profile),
      ) as { Account?: unknown }
      if (typeof identity.Account === 'string' && /^\d{12}$/.test(identity.Account)) {
        account = identity.Account
      }
      const listed = answerOf(
        await this.#run(['eks', 'list-clusters', '--region', region], profile, region),
      ) as { clusters?: unknown }
      const names = Array.isArray(listed.clusters)
        ? listed.clusters.filter((name): name is string => typeof name === 'string')
        : []
      if (names.length === 0) {
        return {
          profile,
          region,
          ...(account ? { account } : {}),
          clusters: [],
          note: `No EKS clusters in ${region} for ${profile}.`,
        }
      }
      const group = `AWS · ${profile}${account ? ` (${account})` : ''} · ${region}`
      const clusters: AwsCluster[] = []
      for (const name of names) {
        clusters.push(await this.#cluster(profile, region, account, name, group))
      }
      return { profile, region, ...(account ? { account } : {}), clusters }
    } catch (error) {
      return {
        profile,
        region,
        ...(account ? { account } : {}),
        clusters: [],
        problem: (error as Error).message,
      }
    }
  }

  /** One cluster: its kubeconfig, or why it can't be added. */
  async #cluster(
    profile: string,
    region: string,
    account: string | undefined,
    name: string,
    group: string,
  ): Promise<AwsCluster> {
    if (!NAME.test(name)) {
      return {
        name: [...name].slice(0, 100).join(''),
        group,
        unaddable: 'Its name isn’t one EKS allows, so Lumovi won’t put it in a command.',
      }
    }
    const described = answerOf(
      await this.#run(
        ['eks', 'describe-cluster', '--region', region, '--name', name],
        profile,
        region,
      ),
    ) as {
      cluster?: {
        endpoint?: unknown
        arn?: unknown
        version?: unknown
        status?: unknown
        certificateAuthority?: { data?: unknown }
      }
    }
    const cluster = described.cluster ?? {}
    const version = typeof cluster.version === 'string' ? cluster.version : undefined
    const status = typeof cluster.status === 'string' ? cluster.status : undefined
    const about = { name, group, ...(version ? { version } : {}), ...(status ? { status } : {}) }
    const endpoint = typeof cluster.endpoint === 'string' ? cluster.endpoint : ''
    if (!URL.canParse(endpoint) || new URL(endpoint).protocol !== 'https:') {
      return { ...about, unaddable: 'EKS gave no https address for it.' }
    }
    const data = cluster.certificateAuthority?.data
    try {
      if (typeof data !== 'string') throw new Error('none')
      new X509Certificate(Buffer.from(data, 'base64'))
    } catch {
      return { ...about, unaddable: 'EKS gave no certificate authority for it.' }
    }
    // Its cluster and user named apart from any other (by its ARN, which names its account),
    // without the account itself: that's in its group alone.
    const arn = typeof cluster.arn === 'string' ? cluster.arn : `${region}:${account ?? ''}:${name}`
    const key = `eks-${createHash('sha256').update(arn).digest('hex').slice(0, 10)}-${name}`
    return {
      ...about,
      server: endpoint,
      kubeconfig: kubeconfigOf(name, key, endpoint, data, region, profile),
    }
  }

  #mayAdd(): void {
    const locked = lockedBy(this.deps.managed)
    if (locked) throw new KubeRequestError('not-allowed', locked, 403)
  }

  /**
   * `aws` with `args`, as `profile` (none of the environment's keys in its way), its answer as
   * JSON (or text, for configure): nothing it could ask is answered, and it's stopped after 30 s.
   */
  #run(args: string[], profile?: string, region?: string): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...this.deps.env, AWS_PAGER: '' }
    for (const key of KEYS) delete env[key]
    if (profile) env.AWS_PROFILE = profile
    const json = args[0] !== 'configure'
    return new Promise((resolve, reject) => {
      const child = spawn(
        'aws',
        [...args, ...(json ? ['--output', 'json'] : []), '--no-cli-pager'],
        {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
      let out = ''
      let err = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, RUN_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        if (out.length < MOST_BYTES) out += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (err.length < MOST_BYTES) err += chunk.toString('utf8')
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(
          error.code === 'ENOENT'
            ? new KubeRequestError(
                'invalid',
                'Lumovi needs the aws command (AWS CLI v2), and this computer doesn’t have it.',
              )
            : error,
        )
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) {
          reject(
            new AwsProblem(
              'aws took more than 30 seconds, so Lumovi stopped it. A profile that asks for something, like an MFA code, can’t be used here: sign in with it in a terminal first.',
            ),
          )
        } else if (code === 0) {
          resolve(out)
        } else {
          reject(new AwsProblem(saidOf(err, profile ?? 'default', region)))
        }
      })
    })
  }
}

/** An answer of `aws` as JSON, or that it isn't (never what the parser quotes of it). */
function answerOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new AwsProblem('aws’s answer wasn’t JSON.')
  }
}

/**
 * A profile's name that a command to paste can hold as it is, in any shell (nothing to quote, nor
 * a leading `@` for PowerShell to splat): else no command is offered.
 */
const plain = (profile: string) => /^\w[\w.@+-]*$/.test(profile)

/** What `aws` said went wrong, in Lumovi's words where it's a known case. */
function saidOf(stderr: string, profile: string, region: string | undefined): string {
  if (/sso/i.test(stderr) && /expired|refresh failed|Error loading SSO Token/i.test(stderr)) {
    return plain(profile)
      ? `Its SSO sign-in has run out: run \`aws sso login --profile ${profile}\` in a terminal, then choose **Find clusters** again.`
      : 'Its SSO sign-in has run out: sign in again with aws sso login for this profile, then choose **Find clusters** again.'
  }
  if (/Unable to locate credentials/i.test(stderr)) {
    return plain(profile)
      ? `This profile has no credentials. Set them up with \`aws configure --profile ${profile}\`, then choose **Find clusters** again.`
      : 'This profile has no credentials. Set them up with aws configure for this profile, then choose **Find clusters** again.'
  }
  if (/AccessDenied|not authorized to perform/i.test(stderr) && region) {
    return `This profile may not list clusters in ${region} (it needs eks:ListClusters).`
  }
  const line =
    stderr
      .split(/\r?\n/)
      .map((text) => text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim())
      .find(Boolean) ?? 'it failed'
  // (aws's words, not Lumovi's: nothing in them made code to copy, or bold.)
  return `aws couldn’t: ${line.replace(/[`*]/g, '').slice(0, 200)}`
}

/**
 * A kubeconfig as `aws eks update-kubeconfig --alias NAME` writes one (its cluster and user named
 * `key`, not by ARN): its endpoint and certificate authority, and a user that runs `aws eks
 * get-token` as the profile chosen, with none of the environment's keys in its way (empty, which
 * `aws` takes as unset).
 */
function kubeconfigOf(
  name: string,
  key: string,
  endpoint: string,
  ca: string,
  region: string,
  profile: string,
): string {
  return stringify({
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: key, cluster: { server: endpoint, 'certificate-authority-data': ca } }],
    contexts: [{ name, context: { cluster: key, user: key } }],
    'current-context': name,
    users: [
      {
        name: key,
        user: {
          exec: {
            apiVersion: 'client.authentication.k8s.io/v1beta1',
            command: 'aws',
            args: [
              '--region',
              region,
              'eks',
              'get-token',
              '--cluster-name',
              name,
              '--output',
              'json',
            ],
            env: [
              { name: 'AWS_PROFILE', value: profile },
              ...KEYS.map((key) => ({ name: key, value: '' })),
            ],
          },
        },
      },
    ],
  })
}
