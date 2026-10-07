// Run in one of Lumovi's terminals: says what kubectl would use there, for the e2e tests.
import { existsSync, readFileSync } from 'node:fs'
import { delimiter } from 'node:path'

const [own, ...yours] = (process.env.KUBECONFIG ?? '').split(delimiter)
const config = JSON.parse(readFileSync(own, 'utf8'))
const { context } = config.contexts.find((c) => c.name === config['current-context'])
console.log(
  `kubectl: context=${config['current-context']} namespace=${context.namespace ?? '-'} then=${yours.length} file(s) found=${yours.filter((file) => existsSync(file)).length} term=${process.env.TERM_PROGRAM}`,
)
console.log(`kubeconfig: [${own}]`)
console.log(`path: last=[${(process.env.PATH ?? process.env.Path ?? '').split(delimiter).at(-1)}]`)
