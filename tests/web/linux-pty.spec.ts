/**
 * A Linux package's terminals (scripts/linux-pty.ts): packed only with a node-pty built for the
 * package's own architecture, as its ELF header says. Each case a packed app with only the
 * header of its pty.node.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkPty, PTY } from '../../scripts/linux-pty.ts'
import { expect, test } from '../temp-folders.ts'

/** A 64-bit little-endian shared object's ELF header, for a machine (e_machine). */
function elf(machine: number): Buffer {
  const header = Buffer.alloc(64)
  header.write('\x7fELF', 0, 'latin1')
  header[4] = 2
  header[5] = 1
  header[6] = 1
  header.writeUInt16LE(3, 16)
  header.writeUInt16LE(machine, 18)
  return header
}

/** An app packed in a folder of `dir`'s, with `pty` as its pty.node (or none). */
function packed(dir: string, name: string, pty?: Buffer): string {
  const app = join(dir, name)
  mkdirSync(dirname(join(app, PTY)), { recursive: true })
  if (pty) writeFileSync(join(app, PTY), pty)
  return app
}

test('each architecture is packed with its own node-pty', async ({ testTemp }) => {
  await expect(checkPty(packed(testTemp, 'x64', elf(62)), 'x64')).resolves.toBeUndefined()
  await expect(checkPty(packed(testTemp, 'arm64', elf(183)), 'arm64')).resolves.toBeUndefined()
})

test('a package with the other architecture’s node-pty fails, naming both', async ({
  testTemp,
}) => {
  // 1.22.1's x64 packages, and its ARM AppImage.
  await expect(checkPty(packed(testTemp, 'x64', elf(183)), 'x64')).rejects.toThrow(
    `Packed for x86-64 (x64) with a ${PTY} for ARM aarch64`,
  )
  await expect(checkPty(packed(testTemp, 'arm64', elf(62)), 'arm64')).rejects.toThrow(
    `Packed for ARM aarch64 (arm64) with a ${PTY} for x86-64`,
  )
})

test('a package without node-pty’s binary, or with one that isn’t a program, fails', async ({
  testTemp,
}) => {
  await expect(checkPty(packed(testTemp, 'none', undefined), 'x64')).rejects.toThrow(
    `Packed for x86-64 (x64) without ${PTY}`,
  )
  const text = packed(testTemp, 'text', Buffer.from('#!/bin/sh\necho not a library\n'))
  await expect(checkPty(text, 'x64')).rejects.toThrow('for no architecture (it isn’t an ELF file)')
  const other = packed(testTemp, 'other', elf(8))
  await expect(checkPty(other, 'x64')).rejects.toThrow('for ELF machine 8')
})
