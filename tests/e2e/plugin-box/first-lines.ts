/**
 * What's tried with a worker's first lines' removals taken away (the tests' build's
 * `openBoxBare`): as Lumovi ships, a plugin's code has no `Worker`, no `importScripts` and no
 * address for text to try any of it with. The first lines are hardening, which a plugin's code
 * could find a way round; the box's policy is the wall, so it has to stop each of these by
 * itself. Shared by the desktop's ways-out spec and the browsers'.
 */
import { literal } from '../../../src/shared/code-literal.ts'

/**
 * The ways that reach for what the first lines take away, and that the policy must stop: a
 * script by its address or from text, a worker of another kind, or one from an address that
 * isn't text of the worker's own.
 */
export const THE_FIRST_LINES_STOP = [
  'importScripts-other',
  'importScripts-blob',
  'worker-data',
  'worker-other',
  'shared-worker-blob',
]

/** What a script that isn't loaded says, and a worker that isn't made. */
const NOT_LOADED = /^threw NetworkError/
const NOT_MADE = /^error event/
/**
 * What each of them says when it's stopped, engine by engine, as seen and held to (the desktop
 * is Chromium's). A script by its address or from text isn't loaded. A worker from an address
 * that isn't text of its own isn't made: an error's event, or in Chromium, from another host, a
 * throw. And no engine gives a worker a `SharedWorker` to make: the one of the five that says
 * there's no such thing. From any other, that would be a worker that tried nothing.
 */
const STOPPED_AS = {
  Chromium: {
    'importScripts-other': NOT_LOADED,
    'importScripts-blob': NOT_LOADED,
    'worker-data': NOT_MADE,
    'worker-other': /^threw: SecurityError$/,
    'shared-worker-blob': /^no such API$/,
  },
  Firefox: {
    'importScripts-other': NOT_LOADED,
    'importScripts-blob': NOT_LOADED,
    'worker-data': NOT_MADE,
    'worker-other': NOT_MADE,
    'shared-worker-blob': /^no such API$/,
  },
  WebKit: {
    'importScripts-other': NOT_LOADED,
    'importScripts-blob': NOT_LOADED,
    'worker-data': NOT_MADE,
    'worker-other': NOT_MADE,
    'shared-worker-blob': /^no such API$/,
  },
} as const satisfies Record<string, Record<string, RegExp>>

/**
 * Of those, the ones that weren't stopped as that engine stops them, each with what it saw.
 * Anything else is the policy letting it by (a script that was imported, a worker that ran), or
 * a way that never tried.
 */
export const notStopped = (
  engine: keyof typeof STOPPED_AS,
  saw: Readonly<Record<string, string>>,
): string[] =>
  THE_FIRST_LINES_STOP.filter(
    (id) => !(STOPPED_AS[engine] as Record<string, RegExp>)[id]?.test(saw[id] ?? ''),
  ).map((id) => `${id}: ${saw[id]}`)

/**
 * And the one the policy allows by design (`worker-src blob:`): a worker made by a plugin's
 * worker, from text. Its child has to be shown to let nothing out.
 */
export const THE_POLICY_ALLOWS = 'worker-blob'

/** What the child runs: the ways, each tried as it's told and said back to what made it. */
const child = (ways: string): string => `${ways}
self.onmessage = async (event) => {
  const told = event.data
  told.context.post = (message) => postMessage(message)
  postMessage(JSON.stringify({ saw: await self.runAttempt(told.attempt, told.context) }))
}
postMessage('ready')`

/**
 * A test plugin that makes a worker of its own from text and has it try each way: what the
 * plugin is told, its child is; what its child says, it says. It's ready when its child is; a
 * child that couldn't be made is said so, and never ready.
 */
export const trierByItsChild = (ways: string): string => `box.then(({ post, listen }) => {
  let made
  try {
    made = new Worker(URL.createObjectURL(new Blob([${literal(child(ways))}], { type: 'text/javascript' })))
  } catch (error) {
    return post('no child: ' + error.name)
  }
  made.onmessage = (event) => post(event.data)
  made.onerror = (event) => post('no child: ' + (event.message || 'error event'))
  listen((told) => { if (told && told.attempt) made.postMessage(told) })
})`
