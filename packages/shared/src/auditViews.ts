/** One line of the audit log, as `GET /api/audit-log` returns it. It never holds secrets. */
export interface AuditEntryView {
  id: string
  at: string
  actorType: 'user' | 'system' | 'lilypad'
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  spaceId: string | null
  meta: Record<string, unknown> | null
}
