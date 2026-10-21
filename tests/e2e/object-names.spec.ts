/**
 * Names and namespaces of one object on the desktop (object-names.ts): what Kubernetes wouldn't
 * accept is refused by every call that takes one, in Lumovi's words, before the cluster is asked;
 * the longest and oddest it does accept work as any other.
 */
import {
  askedOfTheCluster,
  asked,
  DESKTOP_CALLS,
  NAMESPACE_REFUSED,
  NOBODY,
  NOT_NAMESPACES,
  notNamesFor,
  ODDLY_NAMED,
  oddlyAsked,
  refusedFor,
  TAKES_NAME,
  TAKES_NAMESPACE,
  WHERE,
} from './object-names.ts'
import { expect, openCluster, test } from './fixtures.ts'

test('a name or a namespace Kubernetes wouldn’t accept is refused by every call that takes one, in Lumovi’s words, and the cluster isn’t asked', async ({
  page,
  clusters,
}) => {
  await openCluster(page)
  const before = clusters.demo.requests.length
  const said: string[] = []
  const expected: string[] = []
  for (const call of DESKTOP_CALLS) {
    if (TAKES_NAME.includes(call)) {
      for (const name of notNamesFor(call)) {
        said.push(`${call} ${JSON.stringify(name)}: ${await asked(page, call, name, WHERE)}`)
        expected.push(`${call} ${JSON.stringify(name)}: ${refusedFor(call)}`)
      }
    }
    if (TAKES_NAMESPACE.includes(call)) {
      for (const namespace of NOT_NAMESPACES) {
        said.push(
          `${call} in ${JSON.stringify(namespace)}: ${await asked(page, call, NOBODY, namespace)}`,
        )
        expected.push(`${call} in ${JSON.stringify(namespace)}: ${NAMESPACE_REFUSED}`)
      }
    }
  }
  expect(said).toEqual(expected)
  expect(askedOfTheCluster(clusters.demo.requests.slice(before))).toEqual([])
})

test('the longest and oddest names Kubernetes takes are read, changed and deleted as any other', async ({
  page,
  clusters,
}) => {
  for (const { object } of ODDLY_NAMED) clusters.demo.upsert(object)
  await openCluster(page)
  const said: string[] = []
  for (const odd of ODDLY_NAMED) {
    const what = `${odd.kind} ${odd.name.slice(0, 40)}`
    said.push(`${what}: ${await oddlyAsked(page, 'get', odd)}`)
    said.push(`${what}: ${await oddlyAsked(page, 'patch', odd)}`)
    said.push(`${what}: ${await oddlyAsked(page, 'delete', odd)}`)
  }
  expect(said).toEqual(
    ODDLY_NAMED.flatMap((odd) => {
      const what = `${odd.kind} ${odd.name.slice(0, 40)}`
      return [`${what}: named so`, `${what}: named so, labelled`, `${what}: deleted`]
    }),
  )
})
