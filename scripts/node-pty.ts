/**
 * After installing (the "postinstall" script): makes node-pty's spawn-helper
 * executable. node-pty 1.1.0's package has it without the executable bit, so
 * starting a local terminal fails on macOS with "posix_spawnp failed". The
 * packaged app keeps the mode it has here.
 */
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '../node_modules/node-pty')
const helpers = [
  ...(existsSync(join(root, 'prebuilds'))
    ? readdirSync(join(root, 'prebuilds')).map((dir) =>
        join(root, 'prebuilds', dir, 'spawn-helper'),
      )
    : []),
  join(root, 'build/Release/spawn-helper'),
]
for (const helper of helpers.filter((file) => existsSync(file))) chmodSync(helper, 0o755)
