// electron-builder's beforePack hook: helm, for the platform and architecture being packed, in
// build/helm/<platform>-<arch>/, which electron-builder.yml's extraResources copy next to the app
// (and sign, as it signs the app).
import { join } from 'node:path'
import { Arch } from 'electron-builder'
import { fetchHelm } from './helm.ts'

export default async function beforePack(context) {
  const platform = context.electronPlatformName
  const arch = Arch[context.arch]
  await fetchHelm(
    platform,
    arch,
    join(import.meta.dirname, '..', 'build', 'helm', `${platform}-${arch}`),
  )
}
