/**
 * Checks YAML by the cluster's schemas off the page's thread, so a long document never holds
 * typing (`yaml-checker.ts` asks). It keeps the schemas it's sent, by kind, and answers each text
 * with its problems and the kinds its documents say they are, so the page fetches the schemas it
 * hasn't sent yet.
 */
import type { CheckAnswer, CheckAsk, Known } from './yaml-checker'
import { kindsIn, problemsIn } from './yaml-schema'

const schemas = new Map<string, Known>()

// (Only what the page that made it sends, through the worker's own port: a message with no origin.
// Any other is dropped.)
addEventListener('message', (event: MessageEvent<CheckAsk>) => {
  if (event.origin !== '') return
  const { id, text, known } = event.data
  for (const [key, each] of Object.entries(known)) schemas.set(key, each)
  const answer: CheckAnswer = {
    id,
    problems: problemsIn(text, (apiVersion, kind) => {
      const each = schemas.get(`${apiVersion}/${kind}`)
      return { schema: each?.schema, words: each?.words ?? kind }
    }),
    kinds: kindsIn(text),
  }
  postMessage(answer)
})
