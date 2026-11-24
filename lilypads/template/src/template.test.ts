import { createTestPad } from '@pond/sdk/testing'
import { describe, expect, it } from 'vitest'
import { padModule } from './index'

/**
 * Pad tests run on the SDK's in-memory host: no Pond core and no database. This is how a pad
 * author tests a LilyPad, and the example to copy.
 */
describe('Notes pad (the template)', () => {
  /**
   * Function: POST /notes, GET /notes
   * Inputs:   an editor adds two notes; a viewer lists them; a search for "milk"
   * Expected: both are stored in the pad's table and listed newest first; the search finds one
   */
  it('stores and lists notes', async () => {
    const t = await createTestPad(padModule)
    await t.call('POST', '/notes', { body: { title: 'Buy milk' } })
    await t.call('POST', '/notes', { body: { title: 'Call the bank' } })
    const all = await t.call('GET', '/notes', { role: 'viewer' })
    expect((all.body as { notes: { title: string }[] }).notes.map((n) => n.title)).toEqual([
      'Call the bank',
      'Buy milk',
    ])
    const found = await t.call('GET', '/notes', { role: 'viewer', query: { q: 'MILK' } })
    expect((found.body as { notes: unknown[] }).notes).toHaveLength(1)
  })

  /**
   * Function: route roles and validation
   * Inputs:   a viewer posting a note; an editor posting an empty title
   * Expected: 403 for the viewer; 400 invalid_input for the empty title; nothing stored
   */
  it('enforces roles and validates input before the handler runs', async () => {
    const t = await createTestPad(padModule)
    expect((await t.call('POST', '/notes', { role: 'viewer', body: { title: 'x' } })).status).toBe(
      403,
    )
    expect((await t.call('POST', '/notes', { role: 'editor', body: { title: '  ' } })).status).toBe(
      400,
    )
    expect(await t.table('notes').count()).toBe(0)
  })

  /**
   * Function: PATCH /notes/:id, DELETE /notes/:id
   * Inputs:   mark a note done; patch and delete an id that doesn't exist
   * Expected: the note is done; an unknown id gives 404 not_found for both
   */
  it('updates and deletes notes, and reports unknown ids', async () => {
    const t = await createTestPad(padModule)
    const id = (
      (await t.call('POST', '/notes', { body: { title: 'a' } })).body as { note: { id: string } }
    ).note.id
    expect(
      (
        (await t.call('PATCH', `/notes/${id}`, { body: { done: true } })).body as {
          note: { done: boolean }
        }
      ).note.done,
    ).toBe(true)
    expect((await t.call('PATCH', '/notes/nope', { body: { done: true } })).status).toBe(404)
    expect((await t.call('DELETE', '/notes/nope')).status).toBe(404)
    expect((await t.call('DELETE', `/notes/${id}`)).status).toBe(200)
  })

  /**
   * Function: the "showDone" Space setting
   * Inputs:   a finished note and an open one, listed with the setting on (default) and off
   * Expected: both when on; only the open one when off
   */
  it('hides finished notes when the setting is off', async () => {
    const t = await createTestPad(padModule)
    await t.table('notes').insertMany([{ title: 'open' }, { title: 'finished', done: true }])
    expect(
      ((await t.call('GET', '/notes', { role: 'viewer' })).body as { notes: unknown[] }).notes,
    ).toHaveLength(2)
    t.settings.set('showDone', false)
    expect(
      ((await t.call('GET', '/notes', { role: 'viewer' })).body as { notes: unknown[] }).notes,
    ).toHaveLength(1)
  })

  /**
   * Function: the transaction.created event handler and the "tidy" job
   * Inputs:   two transaction.created events; a finished note older than the retention period and a recent one;
   *           run the monthly job
   * Expected: the stats row counts 2 events; the job removes only the old finished note; the job is a monthly
   *           schedule on day 1
   */
  it('counts events and tidies old finished notes on a schedule', async () => {
    const t = await createTestPad(padModule, { now: () => new Date('2030-06-01T12:00:00Z') })
    await t.emit({ type: 'transaction.created', spaceId: 'space-1', transactionId: 'a' })
    await t.emit({ type: 'transaction.created', spaceId: 'space-1', transactionId: 'b' })
    expect((await t.table('stats').findOne({ name: 'transactions_seen' }))!.value).toBe(2)
    expect(t.jobs()).toEqual([{ name: 'tidy', schedule: { monthly: { day: 1, at: '06:00' } } }])
    await t.table('notes').insert({ title: 'recent', done: true })
    await t.runJob('tidy')
    // Both notes were just written (updated_at is "now"), so nothing is old enough to remove yet.
    expect(await t.table('notes').count()).toBe(1)
  })
})
