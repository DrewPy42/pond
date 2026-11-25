import type { Express } from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { makeFilesPad } from '../testing/filesPad'
import {
  PASSWORD,
  Client,
  bootstrapAdmin,
  createUser,
  makeEnv,
  type Account,
  type TestEnv,
} from '../testing/harness'

/**
 * Pad files and the password re-check (docs/business-pad-design.md, M6a). The real app on
 * in-memory fakes (including a fake file store), with real sessions, CSRF and Space roles.
 *
 * Mock data: "olga" owns business Spaces ONE and TWO; "ann" edits ONE; "val" views ONE;
 * "outsider" is in no Space. The "filer" test pad is installed and on in ONE and TWO.
 */

const PDF = Buffer.from('%PDF-1.7 a pretend W-2 for Jane Example')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const HTML = Buffer.from('<html><script>alert(1)</script></html>')

async function world(limit?: number) {
  const env = makeEnv({ pads: [makeFilesPad()], padFailureLimit: limit })
  const admin = await bootstrapAdmin(env)
  const olga = await createUser(env, admin, 'olga', '10.2.0.1')
  const ann = await createUser(env, admin, 'ann', '10.2.0.2')
  const val = await createUser(env, admin, 'val', '10.2.0.3')
  const outsider = await createUser(env, admin, 'outsider', '10.2.0.4')
  const space = async (name: string) =>
    (await admin.client.post('/api/spaces', { name, type: 'business', ownerUserId: olga.id })).body
      .space.id as string
  const one = await space('One')
  const two = await space('Two')
  await olga.client.put(`/api/spaces/${one}/members/${ann.id}`, { role: 'editor' })
  await olga.client.put(`/api/spaces/${one}/members/${val.id}`, { role: 'viewer' })
  await admin.client.post('/api/lilypads/filer/install', { permissions: ['files:store'] })
  for (const s of [one, two])
    await olga.client.put(`/api/spaces/${s}/pads/filer/enabled`, { enabled: true })
  return { env, admin, olga, ann, val, outsider, one, two }
}

const url = (space: string, path: string) => `/api/spaces/${space}/lilypads/filer${path}`

interface SendOptions {
  csrf?: boolean
  contentType?: string
  headers?: Record<string, string>
}
/** Sends bytes as the raw request body, with the account's cookies and CSRF token. */
function upload(app: Express, who: Account, path: string, bytes: Buffer, o: SendOptions = {}) {
  const jar = who.client.jar
  let r = request(app)
    .post(path)
    .set('Cookie', [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '))
    .set('Content-Type', o.contentType ?? 'application/octet-stream')
  if (o.csrf !== false) r = r.set('x-csrf-token', jar.get('pond_csrf') ?? '')
  for (const [k, v] of Object.entries(o.headers ?? {})) r = r.set(k, v)
  return r.send(bytes)
}
/** Fetches a download and keeps the body as bytes. */
function fetchFile(env: TestEnv, who: Account, path: string) {
  return request(env.app)
    .get(path)
    .set('Cookie', [...who.client.jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; '))
    .buffer(true)
    .parse((res, done) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => done(null, Buffer.concat(parts)))
    })
}

describe('pad uploads', () => {
  /**
   * Function: POST (upload route)
   * Inputs:   an editor sends a PDF with ?name=w2.pdf
   * Expected: 200; one file stored under this pad and Space; the pad saw its size and detected type
   *           but never the bytes
   */
  it('stores a file and tells the pad about it, without giving it the bytes', async () => {
    const w = await world()
    const r = await upload(w.env.app, w.ann, url(w.one, '/docs?name=w2.pdf'), PDF)
    expect(r.status).toBe(200)
    expect(r.body.bodySeen).toBe(false)
    expect(w.env.files.keys()).toEqual([`filer/${w.one}/${r.body.fileId}`])
    const rows = await w.env.ctx.repos.padStore
      .table('filer', (w.env.padHost as any).loaded.get('filer').schema, 'docs', w.one) // eslint-disable-line @typescript-eslint/no-explicit-any
      .find()
    expect(rows[0]).toMatchObject({ size: PDF.length, kind: 'pdf', name: 'w2.pdf' })
  })

  /**
   * Function: upload authorization (before the file is read)
   * Inputs:   a signed-out caller, a non-member, a viewer, and an editor without the CSRF token
   * Expected: 401, 404, 403 forbidden and 403 csrf_failed; nothing stored
   */
  it('checks who is calling before accepting anything', async () => {
    const w = await world()
    const path = url(w.one, '/docs?name=a.pdf')
    const anon = { client: new Client(w.env.app) } as Account
    expect((await upload(w.env.app, anon, path, PDF)).status).toBe(401)
    expect((await upload(w.env.app, w.outsider, path, PDF)).status).toBe(404)
    expect((await upload(w.env.app, w.val, path, PDF)).status).toBe(403)
    const noCsrf = await upload(w.env.app, w.ann, path, PDF, { csrf: false })
    expect(noCsrf.body.error).toBe('csrf_failed')
    expect(w.env.files.keys()).toEqual([])
  })

  /**
   * Function: upload authorization order
   * Inputs:   an oversized body from a viewer (not allowed to upload at all)
   * Expected: 403, not 413: the role is checked before the body is read
   */
  it('refuses a caller without reading their file', async () => {
    const w = await world()
    const r = await upload(w.env.app, w.val, url(w.one, '/docs?name=a.pdf'), Buffer.alloc(5000))
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('forbidden')
  })

  /**
   * Function: upload content checks (the route allows PDF and PNG up to 1000 bytes)
   * Inputs:   HTML named x.pdf and claiming to be a PDF; a JPEG; 1001 bytes; an empty body; a
   *           multipart content type; a gzip-encoded body
   * Expected: 415 unsupported_file_type (twice), 413 file_too_large, 400 file_required, 415
   *           unsupported_content_type (twice); nothing stored
   */
  it('judges a file by its contents and size, not its name', async () => {
    const w = await world()
    const send = (bytes: Buffer, o?: SendOptions) =>
      upload(w.env.app, w.ann, url(w.one, '/docs?name=x.pdf'), bytes, o)
    expect((await send(HTML)).body.error).toBe('unsupported_file_type')
    expect((await send(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).body.error).toBe(
      'unsupported_file_type',
    )
    const big = await send(Buffer.concat([PDF, Buffer.alloc(1001)]))
    expect([big.status, big.body.error]).toEqual([413, 'file_too_large'])
    expect((await send(Buffer.alloc(0))).body.error).toBe('file_required')
    expect((await send(PDF, { contentType: 'multipart/form-data; boundary=x' })).body.error).toBe(
      'unsupported_content_type',
    )
    expect((await send(PDF, { headers: { 'Content-Encoding': 'gzip' } })).body.error).toBe(
      'unsupported_content_type',
    )
    expect(w.env.files.keys()).toEqual([])
  })

  /**
   * Function: upload cleanup
   * Inputs:   a handler that throws an expected PadError, one that has a bug, and a request whose
   *           query fails validation
   * Expected: 409, 500 and 400; no file is left behind in any case
   */
  it('leaves no file behind when the request fails', async () => {
    const w = await world()
    const send = (query: string) => upload(w.env.app, w.ann, url(w.one, `/docs${query}`), PDF)
    expect((await send('?name=a&fail=expected')).status).toBe(409)
    expect((await send('?name=a&fail=bug')).status).toBe(500)
    expect((await send('')).status).toBe(400)
    expect(w.env.files.keys()).toEqual([])
  })

  /**
   * Function: a failing disk
   * Inputs:   the file store throws on every write, with a failure limit of 2; three uploads
   * Expected: 500 file_not_saved each time, and the pad is not switched off for it
   */
  it('does not blame the pad when the disk fails', async () => {
    const w = await world(2)
    w.env.files.put = async () => {
      throw new Error('ENOSPC')
    }
    for (let i = 0; i < 3; i++)
      expect((await upload(w.env.app, w.ann, url(w.one, '/docs?name=a'), PDF)).body.error).toBe(
        'file_not_saved',
      )
  })
})

describe('pad downloads', () => {
  async function stored(name: string, bytes = PDF) {
    const w = await world()
    const r = await upload(
      w.env.app,
      w.ann,
      url(w.one, `/docs?name=${encodeURIComponent(name)}`),
      bytes,
    )
    return { w, id: r.body.id as string, fileId: r.body.fileId as string }
  }

  /**
   * Function: a route that returns files.download
   * Inputs:   a viewer downloads a stored PDF named "Jane W-2.pdf"
   * Expected: the same bytes; Content-Type application/pdf; sent as an attachment with that name;
   *           nosniff; no-store
   */
  it('sends the file as a download that browsers will not open in place', async () => {
    const { w, id } = await stored('Jane W-2.pdf')
    const r = await fetchFile(w.env, w.val, url(w.one, `/docs/${id}`))
    expect(r.status).toBe(200)
    expect(Buffer.compare(r.body as Buffer, PDF)).toBe(0)
    expect(r.headers['content-type']).toBe('application/pdf')
    expect(r.headers['content-disposition']).toBe(
      `attachment; filename="Jane W-2.pdf"; filename*=UTF-8''Jane%20W-2.pdf`,
    )
    expect(r.headers['x-content-type-options']).toBe('nosniff')
    expect(r.headers['cache-control']).toBe('no-store')
  })

  /**
   * Function: download filenames
   * Inputs:   a PNG saved as '../../etc/evil.html' and a PDF with quotes and non-English letters
   * Expected: no folders in the name, the ending matches the real type, and the header stays one safe line
   */
  it('cleans the filename and gives it an honest ending', async () => {
    const a = await stored('../../etc/evil.html', PNG)
    const first = await fetchFile(a.w.env, a.w.val, url(a.w.one, `/docs/${a.id}`))
    expect(first.headers['content-disposition']).toContain('filename="_.._etc_evil.html.png"')
    const b = await stored('reçu "2030".pdf')
    const second = await fetchFile(b.w.env, b.w.val, url(b.w.one, `/docs/${b.id}`))
    expect(second.headers['content-disposition']).toBe(
      `attachment; filename="re_u _2030_.pdf"; filename*=UTF-8''re%C3%A7u%20_2030_.pdf`,
    )
  })

  /**
   * Function: download scoping
   * Inputs:   the owner of both Spaces asks, in Space TWO, for the id of a file stored in Space ONE;
   *           and for "../" paths and a made-up id
   * Expected: 404 for each, even though the pad passed the id straight through
   */
  it('cannot reach another Space’s file, even when the pad asks for it', async () => {
    const { w, fileId } = await stored('a.pdf')
    for (const wanted of [fileId, `../${w.one}/${fileId}`, '../../keys/master.key', 'nope']) {
      const r = await w.olga.client.get(
        url(w.two, `/docs/anything?as=${encodeURIComponent(wanted)}`),
      )
      expect(r.status, wanted).toBe(404)
    }
  })

  /**
   * Function: req.files.remove
   * Inputs:   an editor deletes a document
   * Expected: the file is removed from the store
   */
  it('removes files when the pad says so', async () => {
    const { w, id } = await stored('a.pdf')
    expect((await w.ann.client.delete(url(w.one, `/docs/${id}`))).status).toBe(200)
    expect(w.env.files.keys()).toEqual([])
  })

  /**
   * Function: POST /api/lilypads/:padId/uninstall (files)
   * Inputs:   uninstall keeping data, reinstall; then uninstall deleting data
   * Expected: the file survives the first and is gone after the second
   */
  it('keeps or deletes a pad’s files with the rest of its data', async () => {
    const { w } = await stored('a.pdf')
    const uninstall = (deleteData: boolean) =>
      w.admin.client.post('/api/lilypads/filer/uninstall', { deleteData })
    await uninstall(false)
    expect(w.env.files.keys()).toHaveLength(1)
    await w.admin.client.post('/api/lilypads/filer/install', { permissions: ['files:store'] })
    await uninstall(true)
    expect(w.env.files.keys()).toEqual([])
  })
})

describe('password re-check for pad routes', () => {
  const FIVE_MINUTES = 5 * 60 * 1000
  const reauth = (who: Account) => who.client.post('/api/auth/reauth', { password: PASSWORD })

  /**
   * Function: a route with reauth: true
   * Inputs:   an owner 6 minutes after signing in; then after re-entering the password; then 4 and 6
   *           minutes after that
   * Expected: 403 reauth_required; 200 with no-store; 200 at 4 minutes; 403 again at 6
   */
  it('needs the password to have been entered in the last five minutes', async () => {
    const w = await world()
    w.env.advance(FIVE_MINUTES + 60_000)
    const get = () => w.olga.client.get(url(w.one, '/secret/p1'))
    expect((await get()).body.error).toBe('reauth_required')
    await reauth(w.olga)
    const ok = await get()
    expect([ok.status, ok.headers['cache-control']]).toEqual([200, 'no-store'])
    w.env.advance(FIVE_MINUTES - 60_000)
    expect((await get()).status).toBe(200)
    w.env.advance(120_000)
    expect((await get()).status).toBe(403)
  })

  /**
   * Function: reauth does not replace the role check
   * Inputs:   an editor and a non-member who have just re-entered their passwords
   * Expected: 403 forbidden and 404
   */
  it('still requires the role', async () => {
    const w = await world()
    await reauth(w.ann)
    await reauth(w.outsider)
    expect((await w.ann.client.get(url(w.one, '/secret/p1'))).body.error).toBe('forbidden')
    expect((await w.outsider.client.get(url(w.one, '/secret/p1'))).status).toBe(404)
  })

  /**
   * Function: the host's audit entry for reauth routes
   * Inputs:   one successful reveal, one refused for lack of re-check, one that returns 404
   * Expected: exactly one "lilypad.reauth_access" row naming the user, Space, pad and route, and no
   *           audit row anywhere containing the revealed value
   */
  it('audits every successful call, and never the value', async () => {
    const w = await world()
    await reauth(w.olga)
    await w.olga.client.get(url(w.one, '/secret/p1'))
    await w.olga.client.get(url(w.one, '/secret/missing'))
    w.env.advance(FIVE_MINUTES + 1000)
    await w.olga.client.get(url(w.one, '/secret/p1'))
    const all = w.env.ctx.repos.audit.list({ limit: 200 })
    const rows = all.filter((a) => a.action === 'lilypad.reauth_access')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actorId: w.olga.id, spaceId: w.one, targetId: 'filer' })
    expect(rows[0]!.meta).toEqual({ route: 'GET /secret/:id' })
    expect(JSON.stringify(all)).not.toContain('TOP-SECRET-VALUE')
  })

  /**
   * Function: reauth together with downloads and uploads
   * Inputs:   a protected download and a protected upload, before and after the re-check
   * Expected: 403 and nothing stored before; both succeed after, and the download is audited
   */
  it('guards file routes too', async () => {
    const w = await world()
    await upload(w.env.app, w.olga, url(w.one, '/docs?name=a.pdf'), PDF)
    w.env.advance(FIVE_MINUTES + 1000)
    expect((await fetchFile(w.env, w.olga, url(w.one, '/secret-file'))).status).toBe(403)
    const before = w.env.files.keys().length
    const blocked = await upload(w.env.app, w.olga, url(w.one, '/guarded-upload'), PDF)
    expect(blocked.status).toBe(403)
    expect(w.env.files.keys()).toHaveLength(before)
    await reauth(w.olga)
    expect((await fetchFile(w.env, w.olga, url(w.one, '/secret-file'))).status).toBe(200)
    expect((await upload(w.env.app, w.olga, url(w.one, '/guarded-upload'), PDF)).status).toBe(200)
    expect(
      w.env.ctx.repos.audit
        .list({ limit: 200 })
        .filter((a) => a.action === 'lilypad.reauth_access'),
    ).toHaveLength(2)
  })
})

describe('what a pad may declare', () => {
  /**
   * Function: PadHost loading a pad with an upload route it may not have
   * Inputs:   upload without "files:store"; upload on GET; maxBytes over 25 MB; an unknown type;
   *           upload together with a body schema; reauth that isn't true or false
   * Expected: each pad fails to start with a problem saying why
   */
  it('refuses route declarations the host cannot honor', async () => {
    const spec = { maxBytes: 100, types: ['pdf' as const] }
    const cases: [string, Parameters<typeof makeFilesPad>[0], RegExp][] = [
      [
        'no permission',
        {
          permissions: [],
          register: (c) => c.router.post('/u', { role: 'owner', upload: spec }, () => 1),
        },
        /files:store/,
      ],
      [
        'on GET',
        { register: (c) => c.router.get('/u', { role: 'owner', upload: spec }, () => 1) },
        /POST or PUT/,
      ],
      [
        'too big',
        {
          register: (c) =>
            c.router.post(
              '/u',
              { role: 'owner', upload: { ...spec, maxBytes: 26 * 1024 * 1024 } },
              () => 1,
            ),
        },
        /maxBytes/,
      ],
      [
        'unknown type',
        {
          register: (c) =>
            c.router.post(
              '/u',
              { role: 'owner', upload: { ...spec, types: ['html' as never] } },
              () => 1,
            ),
        },
        /Unknown upload type/,
      ],
      [
        'with a body',
        {
          register: (c) =>
            c.router.post('/u', { role: 'owner', upload: spec, body: {} as never }, () => 1),
        },
        /body/,
      ],
      [
        'bad reauth',
        { register: (c) => c.router.get('/u', { role: 'owner', reauth: 'yes' as never }, () => 1) },
        /reauth/,
      ],
    ]
    for (const [name, options, why] of cases) {
      const env = makeEnv({ pads: [makeFilesPad(options)] })
      const admin = await bootstrapAdmin(env)
      const r = await admin.client.post('/api/lilypads/filer/install', {
        permissions: options?.permissions ?? ['files:store'],
      })
      expect(r.body.pad.state, name).toBe('error')
      expect(r.body.pad.problem, name).toMatch(why)
    }
  })
})
