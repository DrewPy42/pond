import { newId } from './db/ids.js'
import type { AuditRepo } from './repos/types.js'

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

export function scrubMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!meta) return null
  return Object.fromEntries(
    Object.entries(meta).map(([k, v]) => [k, FORBIDDEN_META.test(k) ? '[redacted]' : v]),
  )
}

export function recordAudit(
  repo: AuditRepo,
  entry: AuditEntry,
  now: Date = new Date(),
  makeId: () => string = newId,
): void {
  repo.add({
    id: makeId(),
    at: now.toISOString(),
    actorType: entry.actorType ?? (entry.actorId ? 'user' : 'system'),
    actorId: entry.actorId ?? null,
    action: entry.action,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    spaceId: entry.spaceId ?? null,
    meta: scrubMeta(entry.meta),
  })
}
