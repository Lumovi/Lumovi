/**
 * The desktop app's chart repositories (LMV-354): a file of Lumovi's own (0600, in its data
 * folder), for every cluster. A sign-in's password or token is in it only as the system's
 * keychain encrypts it (Electron's safeStorage: the macOS Keychain, Windows' DPAPI, or a Secret
 * Service such as GNOME Keyring or KWallet), never in clear text: where there's no keychain to
 * use (Linux without a Secret Service: what safeStorage calls basic_text), none is kept at all.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { safeStorage } from 'electron'
import type { KeptRepository, RepositoryKeeper } from '@backend/helm/repositories'
import { CHART_NAME, REPOSITORY_ID } from '@shared/helm-repositories'

/** Why no sign-in is kept where there's no keychain. */
export const NO_KEYCHAIN =
  'This computer has no keychain Lumovi can use, and Lumovi won’t write a password to a file. Add the repository without a sign-in, or set up a keychain (such as GNOME Keyring or KWallet), then open this again.'

/** As it's written: each repository, with its sign-in's secret as the keychain encrypted it. */
interface Written {
  repositories: (KeptRepository & { secret?: string })[]
}

type Keychain = Pick<
  typeof safeStorage,
  'isEncryptionAvailable' | 'encryptString' | 'decryptString' | 'getSelectedStorageBackend'
>

export class DesktopRepositories implements RepositoryKeeper {
  readonly kept = 'computer' as const

  constructor(
    private readonly file: string,
    /** Electron's safeStorage, asked each time it's used (the tests stand in for it). */
    private readonly keychain: () => Keychain,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  noSignIns(): string | undefined {
    const keychain = this.keychain()
    if (!keychain.isEncryptionAvailable()) return NO_KEYCHAIN
    // On Linux, a Secret Service it named (GNOME Keyring, KWallet) alone: its plain text, or one
    // it couldn't say (not ready yet, or new to it), isn't a keychain.
    if (
      this.platform === 'linux' &&
      ['basic_text', 'unknown'].includes(keychain.getSelectedStorageBackend())
    ) {
      return NO_KEYCHAIN
    }
    return undefined
  }

  async list(): Promise<KeptRepository[]> {
    return this.#read().map(({ secret: _secret, ...repository }) => repository)
  }

  async put(repository: KeptRepository, secret: string | null | undefined): Promise<void> {
    const written = this.#read()
    const before = written.find((r) => r.id === repository.id)
    let sealed: string | undefined
    if (repository.username !== undefined && secret !== null) {
      if (secret === undefined) sealed = before?.secret
      else {
        const refused = this.noSignIns()
        if (refused) throw new Error(refused)
        sealed = this.keychain().encryptString(secret).toString('base64')
      }
    }
    const next = { ...repository, ...(sealed ? { secret: sealed } : {}) }
    this.#write(
      before ? written.map((r) => (r.id === repository.id ? next : r)) : [...written, next],
    )
  }

  async remove(id: string): Promise<void> {
    this.#write(this.#read().filter((r) => r.id !== id))
  }

  async secret(id: string): Promise<string | undefined> {
    const sealed = this.#read().find((r) => r.id === id)?.secret
    if (!sealed || this.noSignIns()) return undefined
    try {
      return this.keychain().decryptString(Buffer.from(sealed, 'base64'))
    } catch {
      // Another keychain's (a computer restored from another's backup): as if none were saved.
      return undefined
    }
  }

  /** What's kept: what doesn't read as a repository is as if it weren't there. */
  #read(): Written['repositories'] {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    try {
      const { repositories } = JSON.parse(text) as Partial<Written>
      return (Array.isArray(repositories) ? repositories : []).filter(
        (r) =>
          r &&
          typeof r === 'object' &&
          REPOSITORY_ID.test(r.id) &&
          typeof r.name === 'string' &&
          (r.kind === 'http' || r.kind === 'oci') &&
          typeof r.url === 'string' &&
          Array.isArray(r.charts) &&
          r.charts.every((c) => typeof c === 'string' && CHART_NAME.test(c)) &&
          (r.username === undefined || typeof r.username === 'string') &&
          (r.secret === undefined || typeof r.secret === 'string'),
      )
    } catch {
      return []
    }
  }

  /** Written whole, then put in place: never half a file, and only Lumovi's account reads it. */
  #write(repositories: Written['repositories']): void {
    const next = `${this.file}.next`
    writeFileSync(next, `${JSON.stringify({ repositories } satisfies Written, null, 2)}\n`, {
      mode: 0o600,
    })
    renameSync(next, this.file)
  }
}
