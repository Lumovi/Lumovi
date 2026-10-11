/**
 * The door: what Lumovi does with what a plugin's code sends. Here, the first of it: the page
 * a plugin describes, kept as a tree of Lumovi's own parts, with every word of every message
 * checked before it's believed.
 *
 * A plugin's worker sends text and nothing else (the box sees to that). A message is one commit:
 * the steps that change its page. Each step is checked against what's there and against the
 * declaration of the part it names (`kit/declare.ts`); a part gets only the properties declared
 * for it. Nothing a plugin sends is trusted, the kit's own code in its worker included: a plugin
 * can replace that.
 *
 * The first thing that's wrong stops the plugin: its page is never shortened, mended or guessed
 * at. So a page is whole, as its plugin described it, or it's stopped and Lumovi says why.
 */
import { quotedBack } from './kit/characters'
import { unseenProblem, wrongWithFields, type Part } from './kit/declare'

/**
 * What a plugin's page is held to. Each is a first line and not a measured one: what settles it
 * is a real plugin's page at its largest (a first load on a large cluster), once there is one.
 * Over any of them the plugin is stopped.
 */
export const DOOR_LIMITS = {
  /** A message, in characters, before it's read at all. */
  message: 1024 * 1024,
  /** The steps of one commit. */
  stepsACommit: 2000,
  /** Steps and commits in a second: nothing draws faster than the second, and the first bounds
   *  what Lumovi's own page is asked to do. */
  stepsASecond: 20_000,
  commitsASecond: 60,
  /** The parts and texts a page holds at once, attached or not. */
  nodes: 5000,
  /** How deep a page goes: any tree of a plugin's, on the page or not yet. */
  depth: 32,
  /** What one part holds directly. (With the steps in a second, it bounds what a second of a
   *  page's steps can cost Lumovi: a step's work grows with what's beside what it moves.) */
  inOnePart: 1000,
  /** A text on the page, in characters. */
  text: 4000,
  /** Everything a page holds in all: its texts, and its parts' properties as they're written
   *  (names, quotes and all: never less than what's shown). */
  held: 2 * 1024 * 1024,
} as const

/** Why the door stopped a plugin: what a person is told, and what it was, for whoever looks. */
export interface Stopped {
  /**
   * `too-much`: over a ceiling ("It sent more at once than a plugin may."). `not-allowed`:
   * something no plugin's page can say ("It sent something a plugin can’t.").
   */
  why: 'too-much' | 'not-allowed'
  /** What exactly, in Lumovi's own words: for a log and for whoever writes the plugin. */
  what: string
}

/** A part or a text on a plugin's page. */
export interface PageNode {
  /** The part's name; undefined for a text. */
  part?: string
  /** A part's properties, as declared and nothing more. */
  props: Readonly<Record<string, unknown>>
  /** A text's own text. */
  text?: string
  /** What's inside it, in order. */
  children: readonly number[]
}

interface Held extends PageNode {
  children: number[]
  parent?: number
  /** How many levels are under it, itself counted. */
  height: number
  /** The characters it holds: its text, or its properties as text. */
  size: number
}

/** The root of every page: what's put under it is the page. */
export const ROOT = 0

const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/**
 * A plugin's page, as it has described it so far. `parts` are the parts a plugin may name, by
 * name; `now` is a clock in milliseconds: the page's own, never a plugin's, and one that only
 * goes forward (a computer's clock can be set back, and a second would then never end).
 */
export class PluginPage {
  readonly #parts: Readonly<Record<string, Part>>
  readonly #now: () => number
  readonly #nodes = new Map<number, Held>([[ROOT, { props: {}, children: [], height: 1, size: 0 }]])
  /** The newest id made: one made after it has a greater one, so none is ever used twice. */
  #newest = 0
  #held = 0
  #second = { since: 0, steps: 0, commits: 0 }
  #stopped: Stopped | undefined

  constructor(parts: Readonly<Record<string, Part>>, now: () => number = () => performance.now()) {
    this.#parts = parts
    this.#now = now
  }

  /** Why it was stopped, once it has been: nothing more is taken from it. */
  get stopped(): Stopped | undefined {
    return this.#stopped
  }

  /** A part or text of the page, as it is now. */
  node(id: number): PageNode | undefined {
    const node = this.#nodes.get(id)
    // (A copy, and one that can't be changed: the tree is the door's alone.)
    return (
      node &&
      Object.freeze({
        ...(node.part !== undefined && { part: node.part }),
        props: node.props,
        ...(node.text !== undefined && { text: node.text }),
        children: Object.freeze([...node.children]),
      })
    )
  }

  /** How much the page holds: for a test, and for whoever wants to see how near a limit it is. */
  get holds(): { nodes: number; characters: number } {
    return { nodes: this.#nodes.size - 1, characters: this.#held }
  }

  /**
   * Takes one message of a plugin's: the parts that are to be drawn again, or why the plugin is
   * stopped. A stopped page takes nothing more.
   */
  take(message: string): { changed: number[] } | Stopped {
    if (this.#stopped) return this.#stopped
    const result = this.#take(message)
    if ('why' in result) this.#stopped = result
    return result
  }

  #take(message: string): { changed: number[] } | Stopped {
    if (typeof message !== 'string') return notAllowed('a message that isn’t text')
    if (message.length > DOOR_LIMITS.message) return tooMuch('a message', DOOR_LIMITS.message)
    let read: unknown
    try {
      read = JSON.parse(message)
    } catch {
      return notAllowed('a message that can’t be read')
    }
    if (typeof read !== 'object' || read === null || Array.isArray(read)) {
      return notAllowed('a message that isn’t a commit')
    }
    const keys = Object.keys(read)
    const steps = Object.hasOwn(read, 'commit') ? (read as { commit: unknown }).commit : undefined
    // (One key, `commit`, a list.)
    if (keys.length !== 1 || !Array.isArray(steps))
      return notAllowed('a message that isn’t a commit')
    if (steps.length > DOOR_LIMITS.stepsACommit) {
      return tooMuch('the steps of a commit', DOOR_LIMITS.stepsACommit)
    }
    const now = this.#now()
    // (A clock that went back all the same starts the second again.)
    if (now - this.#second.since >= 1000 || now < this.#second.since)
      this.#second = { since: now, steps: 0, commits: 0 }
    this.#second.commits++
    this.#second.steps += steps.length
    if (this.#second.commits > DOOR_LIMITS.commitsASecond) {
      return tooMuch('commits in a second', DOOR_LIMITS.commitsASecond)
    }
    if (this.#second.steps > DOOR_LIMITS.stepsASecond) {
      return tooMuch('steps in a second', DOOR_LIMITS.stepsASecond)
    }
    const changed = new Set<number>()
    for (const [n, step] of steps.entries()) {
      const wrong = this.#step(step, changed)
      if (wrong) return { ...wrong, what: `step ${n + 1}: ${wrong.what}` }
    }
    // (What was taken away within the commit isn't there to draw.)
    return { changed: [...changed].filter((id) => this.#nodes.has(id)) }
  }

  #step(step: unknown, changed: Set<number>): Stopped | undefined {
    if (!Array.isArray(step) || typeof step[0] !== 'string') return notAllowed('isn’t a step')
    const [what, ...said] = step as [string, ...unknown[]]
    switch (what) {
      case 'make':
        return said.length === 3
          ? this.#make(said[0], said[1], said[2])
          : notAllowed('isn’t a step')
      case 'text':
        return said.length === 2
          ? this.#text(said[0], said[1], changed)
          : notAllowed('isn’t a step')
      case 'change':
        return said.length === 2
          ? this.#change(said[0], said[1], changed)
          : notAllowed('isn’t a step')
      case 'put':
        return said.length === 2 || said.length === 3
          ? this.#put(said[0], said[1], said.length === 3 ? said[2] : undefined, changed)
          : notAllowed('isn’t a step')
      case 'take':
        return said.length === 2
          ? this.#remove(said[0], said[1], changed)
          : notAllowed('isn’t a step')
      default:
        return notAllowed('isn’t a step')
    }
  }

  /** `id` as one never used before: greater than every one made. */
  #fresh(id: unknown): id is number {
    return isId(id) && id > this.#newest
  }

  #hold(id: number, node: Held): Stopped | undefined {
    if (this.#nodes.size - 1 >= DOOR_LIMITS.nodes)
      return tooMuch('a page’s parts', DOOR_LIMITS.nodes)
    if (this.#held + node.size > DOOR_LIMITS.held)
      return tooMuch('what a page holds', DOOR_LIMITS.held)
    this.#held += node.size
    this.#nodes.set(id, node)
    this.#newest = id
    return undefined
  }

  /** A part's properties, checked against its declaration: what's wrong, or how much they hold. */
  #props(part: Part, props: unknown): Stopped | number {
    const wrong = wrongWithFields(props, part.props, part.required ?? [], part.name)
    if (wrong) return notAllowed(wrong)
    return JSON.stringify(props).length
  }

  #make(id: unknown, name: unknown, props: unknown): Stopped | undefined {
    if (!this.#fresh(id))
      return notAllowed(`makes something under a number that isn’t new: ${said(id)}`)
    if (typeof name !== 'string' || !Object.hasOwn(this.#parts, name)) {
      return notAllowed(`names a part Lumovi doesn’t have: ${said(name)}`)
    }
    const size = this.#props(this.#parts[name]!, props)
    if (typeof size !== 'number') return size
    return this.#hold(id, {
      part: name,
      props: frozen(props as Record<string, unknown>),
      children: [],
      height: 1,
      size,
    })
  }

  #text(id: unknown, text: unknown, changed: Set<number>): Stopped | undefined {
    if (typeof text !== 'string') return notAllowed('a text that isn’t text')
    if (text.length > DOOR_LIMITS.text) return tooMuch('a text', DOOR_LIMITS.text)
    const unseen = unseenProblem(text, 'a text')
    if (unseen) return notAllowed(unseen)
    if (this.#fresh(id))
      return this.#hold(id, { props: {}, text, children: [], height: 1, size: text.length })
    const node = isId(id) ? this.#nodes.get(id) : undefined
    if (!node || node.part !== undefined)
      return notAllowed('sets the text of something that isn’t a text')
    if (this.#held - node.size + text.length > DOOR_LIMITS.held) {
      return tooMuch('what a page holds', DOOR_LIMITS.held)
    }
    this.#held += text.length - node.size
    this.#nodes.set(id as number, { ...node, text, size: text.length })
    changed.add(id as number)
    return undefined
  }

  #change(id: unknown, props: unknown, changed: Set<number>): Stopped | undefined {
    const node = isId(id) ? this.#nodes.get(id) : undefined
    if (!node || node.part === undefined) return notAllowed('changes something that isn’t a part')
    const size = this.#props(this.#parts[node.part]!, props)
    if (typeof size !== 'number') return size
    if (this.#held - node.size + size > DOOR_LIMITS.held) {
      return tooMuch('what a page holds', DOOR_LIMITS.held)
    }
    this.#held += size - node.size
    this.#nodes.set(id as number, {
      ...node,
      props: frozen(props as Record<string, unknown>),
      size,
    })
    changed.add(id as number)
    return undefined
  }

  /** How many parts deep `id` is in its tree, itself counted (the root is no part: 0). */
  #depth(id: number): number {
    let depth = 0
    for (let at: number | undefined = id; at !== undefined && at !== ROOT;) {
      depth++
      at = this.#nodes.get(at)!.parent
    }
    return depth
  }

  /** `height`, counted again from what's under `id`, and so on up: after something is taken away. */
  #measure(id: number): void {
    for (let at: number | undefined = id; at !== undefined;) {
      const node: Held = this.#nodes.get(at)!
      let height = 1
      for (const child of node.children)
        height = Math.max(height, 1 + this.#nodes.get(child)!.height)
      if (height === node.height) return
      node.height = height
      at = node.parent
    }
  }

  #put(into: unknown, id: unknown, before: unknown, changed: Set<number>): Stopped | undefined {
    const parent =
      into === ROOT ? this.#nodes.get(ROOT) : isId(into) ? this.#nodes.get(into) : undefined
    const child = isId(id) ? this.#nodes.get(id) : undefined
    if (!parent || !child) return notAllowed('puts something that isn’t there, or where nothing is')
    const where = into as number
    // One parent: what's under another part stays there until it's taken away (and then it's gone).
    if (child.parent !== undefined && child.parent !== where) {
      return notAllowed('puts under one part what’s under another')
    }
    // What a part may hold is its declaration's to say; the root holds parts.
    const holds = where === ROOT ? 'parts' : this.#parts[parent.part ?? '']?.holds
    const allowed =
      child.part === undefined
        ? holds === 'text'
        : holds === 'parts' || (Array.isArray(holds) && holds.includes(child.part))
    if (!allowed) {
      const inside = child.part === undefined ? 'a text' : `a ${child.part}`
      const into =
        where === ROOT
          ? 'the page itself'
          : parent.part === undefined
            ? 'a text'
            : `a ${parent.part}`
      const only =
        holds === undefined || holds === 'nothing'
          ? 'nothing'
          : holds === 'text'
            ? 'only text'
            : holds === 'parts'
              ? 'only parts'
              : `only ${holds.join(', ')}`
      return notAllowed(`puts ${inside} into ${into}, which holds ${only}`)
    }
    // No loop: a part is never put under itself, or under what's under it.
    for (let at: number | undefined = where; at !== undefined; at = this.#nodes.get(at)?.parent) {
      if (at === id) return notAllowed('puts a part under itself')
    }
    // How deep its tree would be: one rule on the page and off it, so nothing is built that
    // could never be put on.
    const under = Math.max(parent.height, child.height + 1)
    if (this.#depth(where) + under - 1 > DOOR_LIMITS.depth) {
      return tooMuch('how deep a page goes', DOOR_LIMITS.depth)
    }
    if (child.parent === undefined && parent.children.length >= DOOR_LIMITS.inOnePart) {
      return tooMuch('what one part holds', DOOR_LIMITS.inOnePart)
    }
    let at = parent.children.length
    if (before !== undefined) {
      at = isId(before) && before !== id ? parent.children.indexOf(before) : -1
      if (at < 0) return notAllowed('puts something before what isn’t beside it')
    }
    // (Again under the same part: moved.)
    const was = parent.children.indexOf(id as number)
    if (was >= 0) {
      parent.children.splice(was, 1)
      if (before !== undefined) at = parent.children.indexOf(before as number)
      else at = parent.children.length
    }
    parent.children.splice(at, 0, id as number)
    child.parent = where
    // (Putting only ever makes a tree taller: no counting again.)
    for (let up: Held | undefined = parent, height = under; up && up.height < height; height++) {
      up.height = height
      up = up.parent === undefined ? undefined : this.#nodes.get(up.parent)
    }
    changed.add(where)
    return undefined
  }

  /**
   * Takes a part or a text away from where it is: it's gone, with all that's under it. What was
   * made and never put anywhere is taken from nowhere (`null`).
   */
  #remove(from: unknown, id: unknown, changed: Set<number>): Stopped | undefined {
    if (from === null) {
      const loose = isId(id) ? this.#nodes.get(id) : undefined
      if (!loose || loose.parent !== undefined) return notAllowed('takes away what isn’t there')
      this.#forget(id as number)
      return undefined
    }
    const parent =
      from === ROOT ? this.#nodes.get(ROOT) : isId(from) ? this.#nodes.get(from) : undefined
    const at = parent && isId(id) ? parent.children.indexOf(id) : -1
    if (!parent || at < 0) return notAllowed('takes away what isn’t there')
    parent.children.splice(at, 1)
    this.#forget(id as number)
    this.#measure(from as number)
    changed.add(from as number)
    return undefined
  }

  #forget(id: number): void {
    const gone = [id]
    for (const next of gone) {
      const node = this.#nodes.get(next)!
      gone.push(...node.children)
      this.#held -= node.size
      this.#nodes.delete(next)
    }
  }
}

/** What a plugin sent, said back in a line about it: short, on one line, nothing unseen. */
const said = (value: unknown) =>
  quotedBack(typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))).slice(
    typeof value === 'string' ? 0 : 1,
    typeof value === 'string' ? undefined : -1,
  )

/** What was checked, so that nothing after the door can change it. */
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) frozen(inner)
    Object.freeze(value)
  }
  return value
}

const notAllowed = (what: string): Stopped => ({ why: 'not-allowed', what })
const tooMuch = (what: string, most: number): Stopped => ({
  why: 'too-much',
  what: `${what}: more than ${most.toLocaleString('en-US')}`,
})
