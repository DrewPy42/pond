import { PadError, definePad, z } from '@pond/sdk'

const noteBody = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(2000).optional(),
})

export default definePad({
  register(ctx) {
    // Every route says who may call it. Validation runs before the handler; return plain data.
    ctx.router.get(
      '/notes',
      { role: 'viewer', query: z.object({ q: z.string().trim().max(100).optional() }) },
      async (req) => {
        const showDone = await req.settings.get<boolean>('showDone')
        const where = {
          ...(req.query.q ? { title: { contains: req.query.q } } : {}),
          ...(showDone ? {} : { done: false }),
        }
        const notes = await req.db
          .table('notes')
          .find({ where, orderBy: [['created_at', 'desc']], limit: 200 })
        return { notes }
      },
    )

    ctx.router.post('/notes', { role: 'editor', body: noteBody }, async (req) => {
      const note = await req.db
        .table('notes')
        .insert({ title: req.body.title, body: req.body.body ?? null })
      await req.audit.record({
        action: 'note.created',
        targetType: 'note',
        targetId: note.id as string,
      })
      return { note }
    })

    ctx.router.patch(
      '/notes/:id',
      {
        role: 'editor',
        body: z.object({
          title: z.string().trim().min(1).max(120).optional(),
          done: z.boolean().optional(),
        }),
      },
      async (req) => {
        const changed = await req.db
          .table('notes')
          .update({ id: req.params.id! }, req.body as Record<string, string | boolean>)
        if (changed === 0) throw new PadError(404, 'not_found')
        return { note: await req.db.table('notes').findOne({ id: req.params.id! }) }
      },
    )

    ctx.router.delete('/notes/:id', { role: 'editor' }, async (req) => {
      if ((await req.db.table('notes').delete({ id: req.params.id! })) === 0)
        throw new PadError(404, 'not_found')
      return { ok: true }
    })

    // Reading core data needs a granted permission; this pad asked for "transactions:read".
    ctx.router.get('/summary', { role: 'viewer' }, async (req) => {
      const notes = await req.db.table('notes').count()
      const open = await req.db.table('notes').count({ done: false })
      const seen = await req.db.table('stats').findOne({ name: 'transactions_seen' })
      const recent = await req.core.transactions.list({ limit: 1 })
      return {
        notes,
        open,
        transactionsSeen: (seen?.value as number | undefined) ?? 0,
        transactionsInSpace: recent.total,
      }
    })

    // Events arrive after the change is committed, scoped to the Space, with no logged-in user.
    ctx.events.on('transaction.created', async (_event, scope) => {
      const stats = scope.db.table('stats')
      const row = await stats.findOne({ name: 'transactions_seen' })
      if (row) await stats.update({ id: row.id as string }, { value: (row.value as number) + 1 })
      else await stats.insert({ name: 'transactions_seen', value: 1 })
    })

    // Structured schedules (no cron): this runs once per Space on the 1st at 06:00 local time.
    ctx.jobs.schedule('tidy', { monthly: { day: 1, at: '06:00' } }, async (scope) => {
      const days = await scope.settings.get<number>('retentionDays')
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
      const removed = await scope.db
        .table('notes')
        .delete({ done: true, updated_at: { lt: cutoff } })
      if (removed > 0) scope.log.info('Removed old finished notes', { removed })
    })
  },
})
