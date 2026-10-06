/**
 * The server's audit log: its history kept on a volume (or in memory, if
 * there's none), each event on the server's output and to a webhook; who
 * did what, and from where; and who may read everyone's.
 */
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { AuditActor, AuditEvent } from '@shared/audit'
import type { SessionUser } from '@shared/server'
import { AuditLog } from '@backend/audit/log'
import { StdoutSink, WebhookSink, type AuditSink } from '@backend/audit/sinks'
import { FileStore, MemoryStore } from '@backend/audit/store'
import type { Identity } from './cluster'
import type { AuditConfig } from './config'
import { log } from './log'

export function openAudit(config: AuditConfig): AuditLog {
  const sinks: AuditSink[] = []
  if (config.stdout) sinks.push(new StdoutSink())
  if (config.webhook) sinks.push(new WebhookSink(config.webhook))
  if (!config.dir) {
    log(
      'The audit history is kept in memory: the Audit page shows what happened since Lumovi started. Set LUMOVI_AUDIT_DIR (the Helm chart’s audit.persistence) to keep it.',
    )
  }
  return new AuditLog({
    store: config.dir
      ? new FileStore(config.dir, config.retentionDays)
      : new MemoryStore(config.memoryEvents),
    sinks,
    level: config.level,
    scanLimit: config.scanLimit,
    warn: log,
  })
}

/** A session, as the audit log names it: by a hash, so it says which without giving it away. */
export const sessionTag = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16)

/** Where a request came from: its connection's address, and what a proxy says it forwarded. */
export function origin(
  req: IncomingMessage,
): Pick<AuditActor, 'address' | 'forwardedFor' | 'userAgent'> {
  const forwarded = req.headers['x-forwarded-for']
  const agent = req.headers['user-agent']
  return {
    address: req.socket.remoteAddress,
    ...(forwarded ? { forwardedFor: String(forwarded).slice(0, 200) } : {}),
    ...(agent ? { userAgent: agent.slice(0, 300) } : {}),
  }
}

/** Someone, through Lumovi's page (or signing in to it), from where their request came. */
export const personActor = (
  user: SessionUser,
  req: IncomingMessage,
  session?: string,
): AuditActor => ({
  user: user.name,
  ...(user.groups.length ? { groups: user.groups } : {}),
  via: 'ui',
  ...(session ? { session: sessionTag(session) } : {}),
  ...origin(req),
})

/** The server itself: starting, stopping, and its log. */
export const SERVER_ACTOR: AuditActor = { user: 'lumovi', via: 'server' }

/** Whether someone reads everyone's events: they're one of LUMOVI_AUDITORS, or in its groups. */
export const isAuditor = (config: AuditConfig, identity: Identity) =>
  config.auditors.users.includes(identity.user.name) ||
  identity.user.groups.some((group) => config.auditors.groups.includes(group))

/** Whose events someone may see: everyone's (an auditor), or their own. */
export const readerFor = (auditor: boolean, user: SessionUser) =>
  auditor
    ? () => true
    : (event: AuditEvent) => event.actor.user === user.name && event.actor.via !== 'server'
