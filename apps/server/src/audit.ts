import type { Db } from './db/index.js'
import { newId } from './db/ids.js'
import { auditLog } from './db/schema.js'

export interface AuditEntry {
  actorType?: 'user' | 'system' | 'lilypad'
  actorId?: string | null
  action: string
  targetType?: string
  targetId?: string
  spaceId?: string
  /** Never put secrets here (CLAUDE.md rule 7). */
  meta?: Record<string, unknown>
}

/** Keys that must never be written to the audit log, even by mistake. */
const FORBIDDEN_META = /pass|secret|token|totp|ssn|ein|access_?url|cookie|key|code/i

function scrub(meta: Record<string, unknown> | undefined) {
  if (!meta) return undefined
  return Object.fromEntries(
    Object.entries(meta).map(([k, v]) => [k, FORBIDDEN_META.test(k) ? '[redacted]' : v]),
  )
}

export function recordAudit(db: Db, entry: AuditEntry, now: Date = new Date()): void {
  db.insert(auditLog)
    .values({
      id: newId(),
      at: now.toISOString(),
      actorType: entry.actorType ?? (entry.actorId ? 'user' : 'system'),
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      spaceId: entry.spaceId ?? null,
      meta: scrub(entry.meta) ?? null,
    })
    .run()
}
