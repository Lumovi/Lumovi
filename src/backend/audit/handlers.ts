/**
 * What the Audit page asks for, wherever Lumovi runs: what the log is,
 * its events (those the person may see), whether its chain holds, and
 * events as they're recorded.
 */
import { IPC } from '@shared/api'
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES, isAuditAction, type AuditQuery } from '@shared/audit'
import type { Handler } from '../handlers'
import type { AuditLog, AuditReader } from './log'

const CATEGORIES = AUDIT_CATEGORIES.map((c) => c.value as string)
const OUTCOMES = AUDIT_OUTCOMES.map((o) => o.value as string)
const VIA = ['ui', 'assistant', 'server']

const bad = (what: string) => new Error(`An audit search’s ${what} isn’t what Lumovi takes.`)

/** A page's search, checked: anything it doesn't take is said, not ignored. */
export function checkedQuery(value: unknown): AuditQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw bad('form')
  const q = value as Record<string, unknown>
  const texts = (key: string, allowed?: string[]) => {
    const list = q[key]
    if (list === undefined) return undefined
    if (
      !Array.isArray(list) ||
      list.length > 100 ||
      !list.every((item) => typeof item === 'string' && (!allowed || allowed.includes(item)))
    ) {
      throw bad(key)
    }
    return list as string[]
  }
  const time = (key: string) => {
    const given = q[key]
    if (given === undefined) return undefined
    if (typeof given !== 'string' || Number.isNaN(Date.parse(given))) throw bad(key)
    return new Date(given).toISOString()
  }
  const target = q.target as Record<string, unknown> | undefined
  if (
    target !== undefined &&
    (typeof target !== 'object' ||
      target === null ||
      typeof target.kind !== 'string' ||
      !['name', 'namespace', 'uid'].every(
        (key) => target[key] === undefined || typeof target[key] === 'string',
      ))
  ) {
    throw bad('object')
  }
  if (q.text !== undefined && (typeof q.text !== 'string' || q.text.length > 500)) throw bad('text')
  if (
    q.after !== undefined &&
    (typeof q.after !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(q.after))
  ) {
    throw bad('place')
  }
  if (q.limit !== undefined && !Number.isInteger(q.limit)) throw bad('limit')
  const actions = texts('actions')
  if (actions && !actions.every(isAuditAction)) throw bad('actions')
  return {
    from: time('from'),
    to: time('to'),
    users: texts('users'),
    clusters: texts('clusters'),
    namespaces: texts('namespaces'),
    kinds: texts('kinds'),
    categories: texts('categories', CATEGORIES) as AuditQuery['categories'],
    actions: actions as AuditQuery['actions'],
    outcomes: texts('outcomes', OUTCOMES) as AuditQuery['outcomes'],
    via: texts('via', VIA) as AuditQuery['via'],
    assistants: texts('assistants'),
    target: target as AuditQuery['target'],
    text: q.text as string | undefined,
    after: q.after as string | undefined,
    limit: q.limit as number | undefined,
  }
}

/** Who reads: whether they see everyone's events, and which they may. */
export interface AuditReading {
  everyone: boolean
  may: AuditReader
}

export function auditHandlers(
  log: AuditLog,
  reading: AuditReading,
  emit: (channel: string, ...args: unknown[]) => void,
): { invoke: Record<string, Handler>; stop(): void } {
  let watching: (() => void) | undefined
  return {
    invoke: {
      [IPC.auditInfo]: () => log.info(reading.everyone),
      [IPC.auditQuery]: (query) => log.query(checkedQuery(query), reading.may, reading.everyone),
      [IPC.auditVerify]: () => {
        if (!reading.everyone) {
          throw new Error('Only an auditor checks the whole audit log: it holds everyone’s events.')
        }
        return log.verify()
      },
      [IPC.auditWatch]: (on) => {
        watching?.()
        watching =
          on === true
            ? log.subscribe((event) => {
                if (reading.may(event)) emit(IPC.auditEvent, event)
              })
            : undefined
      },
    },
    stop: () => watching?.(),
  }
}
