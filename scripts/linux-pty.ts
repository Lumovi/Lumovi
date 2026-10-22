// Terminals on this computer, in a Linux package: node-pty's pty.node, which is built as node-pty
// is installed, for the computer that installs it (see electron-builder.yml). A package for
// another architecture would carry that computer's, and stop as it starts: so each is checked as
// it's packed (scripts/after-pack.mjs), by what its ELF header says it's for.
import { open } from 'node:fs/promises'
import { join } from 'node:path'

/** node-pty's own binary, in a packed app. */
export const PTY = join(
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'node-pty',
  'build',
  'Release',
  'pty.node',
)

/** An ELF header's machine (e_machine) for each of Node's architectures, and `file`'s name for it. */
const MACHINES: Record<string, { machine: number; name: string }> = {
  x64: { machine: 62, name: 'x86-64' },
  arm64: { machine: 183, name: 'ARM aarch64' },
  armv7l: { machine: 40, name: 'ARM' },
  ia32: { machine: 3, name: 'Intel 80386' },
}

/** An ELF file's machine, or undefined for a file that isn't one. */
async function machineOf(path: string): Promise<number | undefined> {
  const file = await open(path)
  try {
    const { bytesRead, buffer } = await file.read(Buffer.alloc(20), 0, 20, 0)
    if (bytesRead < 20 || buffer.toString('latin1', 0, 4) !== '\x7fELF') return undefined
    // (Its sixth byte: 2 when it's big-endian.)
    return buffer[5] === 2 ? buffer.readUInt16BE(18) : buffer.readUInt16LE(18)
  } finally {
    await file.close()
  }
}

/** Throws unless the app packed in `appOutDir` has node-pty's binary, for `arch` (x64, arm64…). */
export async function checkPty(appOutDir: string, arch: string): Promise<void> {
  const want = MACHINES[arch]
  if (!want) throw new Error(`Packed for ${arch}, which node-pty's binary isn't checked for.`)
  const machine = await machineOf(join(appOutDir, PTY)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (machine === null) {
    throw new Error(`Packed for ${want.name} (${arch}) without ${PTY}: terminals couldn't start.`)
  }
  const theirs =
    machine === undefined
      ? 'no architecture (it isn’t an ELF file)'
      : (Object.values(MACHINES).find((known) => known.machine === machine)?.name ??
        `ELF machine ${machine}`)
  if (machine !== want.machine) {
    throw new Error(
      `Packed for ${want.name} (${arch}) with a ${PTY} for ${theirs}, which wouldn't start: ` +
        'node-pty is built for the computer that installs it, so each Linux architecture is ' +
        'packed on its own, on a computer of that architecture (--x64 or --arm64).',
    )
  }
}
