// electron-builder's afterPack hook: the one fuse that's each platform's own, and on Linux, the
// terminals' node-pty, for the architecture being packed.
//
// Running the app as Node (ELECTRON_RUN_AS_NODE) is off, except on Windows: AI assistants start
// Lumovi's stdio bridge that way there (out/mcp-stdio/bridge.cjs), as the app's main process
// can't read stdin on Windows. The other fuses are electron-builder.yml's, flipped after this.
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { Arch } from 'electron-builder'
import { checkPty } from './linux-pty.ts'

export default async function afterPack(context) {
  if (context.electronPlatformName === 'linux') {
    await checkPty(context.appOutDir, Arch[context.arch])
  }
  await context.packager.addElectronFuses(context, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: context.electronPlatformName === 'win32',
    // Flipping fuses breaks the ad-hoc signature unsigned builds run with on Apple silicon.
    resetAdHocDarwinSignature: true,
  })
}
