/**
 * A sealed document: one script in it, named in its policy by its hash. The script's text is
 * Lumovi's own, and it must be one that can sit whole in a script element.
 */
import { createHash } from 'node:crypto'
import { expect, test } from '../temp-folders.ts'
import { BOX_SCRIPT_SOURCE, scriptSource } from '../../src/backend/plugin-box-script.ts'
import { BOX_SCRIPT, boxDocument, boxHeaders, sealedDocument } from '../../src/shared/plugin-box.ts'
import { scriptsIn } from '../e2e/plugin-box/sealed.ts'

test('a box’s script sits whole in its document, and its policy names exactly that text', () => {
  // Nothing in it ends a script element, or opens a comment in one: an edit that added either
  // (in a string, in a comment) would leave the rest as the document's markup.
  expect(BOX_SCRIPT).not.toMatch(/<\/script|<!--/i)
  // One script, with nothing said of it, and its text Lumovi's own.
  expect(scriptsIn(boxDocument())).toEqual([{ said: '', text: BOX_SCRIPT }])
  // Named by the hash of that very text, made from it, and by nothing else.
  const hash = `'sha256-${createHash('sha256').update(BOX_SCRIPT).digest('base64')}'`
  expect(BOX_SCRIPT_SOURCE).toBe(hash)
  expect(scriptSource(BOX_SCRIPT)).toBe(hash)
  const policy = boxHeaders(BOX_SCRIPT_SOURCE, 'https://lumovi.example')['Content-Security-Policy']!
  expect(policy).toContain(`script-src ${hash};`)
  expect(policy.replace('frame-ancestors https://lumovi.example', '')).not.toMatch(/[a-z]+:\/\//)
})

test('a script that couldn’t sit whole in a script element makes no sealed document', () => {
  for (const script of [
    'const a = "</script>"',
    'const a = 1 // </SCRIPT ',
    'if (a <!-- b) {}',
    '</script><img src=x>',
  ]) {
    expect(() => sealedDocument(script), script).toThrow(/can’t hold what ends a script element/)
  }
  expect(sealedDocument('const a = 1 < 2')).toContain('<script>const a = 1 < 2</script>')
})

test('a document’s scripts are found as a browser finds them: in any case, and past an end tag that carries more', () => {
  expect(
    scriptsIn('<SCRIPT>one</SCRIPT ><script src="x">two</script\n data-x><Script>three</sCRIPT>'),
  ).toEqual([
    { said: '', text: 'one' },
    { said: ' src="x"', text: 'two' },
    { said: '', text: 'three' },
  ])
})
