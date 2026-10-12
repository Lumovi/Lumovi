/**
 * A server's plugins folder, with a file each way one can fail to be read: a link to a folder, a
 * file over the size limit, one the server may not read, a link to itself, and a link to
 * nothing. Each is said by its name alone, in Lumovi's words, and the rest still load.
 */
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LocalPlugins } from '../../src/shared/api.ts'
import { DEMO_TOKEN, expect, signIn, test } from './fixtures.ts'

const WIDGETS =
  'apiVersion: lumovi.dev/v1beta1\nkind: Plugin\nmetadata: { name: widgets }\nspec: { version: 1.0.0, needs: { lumovi: 1.0.0 }, groups: [example.com], views: [{ kinds: [{ group: example.com, kind: Widget }] }] }\n'

test('a plugins folder’s files that can’t be read are each said by name, and the others load', async ({
  page,
  serve,
}) => {
  test.skip(
    process.platform === 'win32',
    'Making links, and a file nobody may read, take more on Windows',
  )
  const folder = mkdtempSync(join(tmpdir(), 'lumovi-plugins-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'lumovi-elsewhere-'))
  writeFileSync(join(folder, 'a-widgets.yaml'), WIDGETS)
  // A link to a folder, not a file.
  mkdirSync(join(elsewhere, 'a-folder.yaml'))
  symlinkSync(join(elsewhere, 'a-folder.yaml'), join(folder, 'b-folder.yaml'))
  // Over the limit: 256 KB and a byte.
  writeFileSync(join(folder, 'c-large.yaml'), `# ${'x'.repeat(256 * 1024)}\n`)
  // One nobody may read. (Nobody but root: like GitHub's, the runner isn't.)
  writeFileSync(join(folder, 'd-locked.yaml'), WIDGETS)
  chmodSync(join(folder, 'd-locked.yaml'), 0)
  try {
    // A link to itself, and a link to nothing.
    symlinkSync('e-loop.yaml', join(folder, 'e-loop.yaml'))
    symlinkSync('nowhere.yaml', join(folder, 'f-gone.yaml'))

    const served = await serve({ env: { LUMOVI_PLUGINS_DIR: folder } })
    await signIn(page, `${served.url}cluster/demo/pods`, DEMO_TOKEN)
    const read = await page.evaluate(() =>
      (
        window as unknown as { lumovi: { app: { plugins(): Promise<LocalPlugins> } } }
      ).lumovi.app.plugins(),
    )
    expect(read.files.map(({ name, error }) => [name, error ?? 'read'])).toEqual([
      ['a-widgets.yaml', 'read'],
      ['b-folder.yaml', 'It isn’t a file.'],
      ['c-large.yaml', 'It’s larger than 256 KB.'],
      ['d-locked.yaml', 'Lumovi isn’t allowed to read it.'],
      ['e-loop.yaml', 'It couldn’t be read.'],
      ['f-gone.yaml', 'It isn’t there: a link to a file that’s gone.'],
    ])
    // Nothing of the folder's path is said to the page: only each file's name.
    expect(JSON.stringify(read.files)).not.toContain(folder)
  } finally {
    // (Put back as it was, whatever came of the test, for whoever cleans the folder up.)
    chmodSync(join(folder, 'd-locked.yaml'), 0o600)
  }
})
