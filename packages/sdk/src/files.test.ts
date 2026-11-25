import { describe, expect, it } from 'vitest'
import { definePad, definePadModule } from './context.js'
import { defineMigration } from './data.js'
import { checkUploadSpec, detectFileType, safeDownloadName } from './files.js'
import { manifestSchema } from './manifest.js'
import { createTestPad } from './testing/index.js'

const PDF = new TextEncoder().encode('%PDF-1.7 pretend')

describe('detectFileType', () => {
  /**
   * Function: detectFileType
   * Inputs:   the opening bytes of a PDF, a JPEG and a PNG; HTML text; half a PNG header; nothing
   * Expected: pdf, jpeg, png, and null for the rest
   */
  it('reads the type from the first bytes', () => {
    expect(detectFileType(PDF)).toBe('pdf')
    expect(detectFileType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe('jpeg')
    expect(detectFileType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'png',
    )
    expect(detectFileType(new TextEncoder().encode('<html>'))).toBeNull()
    expect(detectFileType(new Uint8Array([0x89, 0x50, 0x4e]))).toBeNull()
    expect(detectFileType(new Uint8Array())).toBeNull()
  })
})

describe('safeDownloadName', () => {
  /**
   * Function: safeDownloadName
   * Inputs:   names with folders, a line break, a right-to-left override, leading dots, only dots,
   *           300 characters, a wrong ending, and a correct ".JPG" ending
   * Expected: one clean name with no path or hidden characters, at most 150 characters plus the
   *           ending, whose ending matches the real type
   */
  it('cleans names and keeps the ending honest', () => {
    expect(safeDownloadName('a/b\\c.pdf', 'pdf')).toBe('a_b_c.pdf')
    expect(safeDownloadName('bad\r\nname.pdf', 'pdf')).toBe('badname.pdf')
    expect(safeDownloadName('invoice‮fdp.exe', 'pdf')).toBe('invoicefdp.exe.pdf')
    expect(safeDownloadName('..hidden.png', 'png')).toBe('hidden.png')
    expect(safeDownloadName('...', 'pdf')).toBe('file.pdf')
    expect(safeDownloadName('x'.repeat(300), 'pdf')).toBe(`${'x'.repeat(150)}.pdf`)
    expect(safeDownloadName('page.html', 'pdf')).toBe('page.html.pdf')
    expect(safeDownloadName('photo.JPG', 'jpeg')).toBe('photo.JPG')
    expect(safeDownloadName('notes.txt', null)).toBe('notes.txt')
  })
})

describe('checkUploadSpec', () => {
  /**
   * Function: checkUploadSpec
   * Inputs:   a good spec; zero, fractional and over-25 MB sizes; no types; an unknown type
   * Expected: only the good spec passes
   */
  it('accepts only specs the host can honor', () => {
    expect(() => checkUploadSpec({ maxBytes: 1000, types: ['pdf'] })).not.toThrow()
    for (const maxBytes of [0, 1.5, 25 * 1024 * 1024 + 1])
      expect(() => checkUploadSpec({ maxBytes, types: ['pdf'] })).toThrow()
    expect(() => checkUploadSpec({ maxBytes: 1, types: [] })).toThrow()
    expect(() => checkUploadSpec({ maxBytes: 1, types: ['gif' as never] })).toThrow()
  })
})

describe('the SDK test host with files and re-check', () => {
  const pad = definePadModule({
    manifest: manifestSchema.parse({
      id: 'filer',
      name: 'Filer',
      version: '1.0.0',
      author: 'Tests',
      license: 'MIT',
      pondApi: '^1.1',
      spaceTypes: ['business'],
      permissions: ['files:store'],
    }),
    migrations: [
      defineMigration('0001_init', (m) => m.createTable('x', { columns: { a: 'text' } })),
    ],
    server: definePad({
      register(ctx) {
        ctx.router.post(
          '/f',
          { role: 'owner', upload: { maxBytes: 100, types: ['pdf'] } },
          (req) => {
            if (req.query && (req.query as { fail?: string }).fail) throw new Error('boom')
            return { fileId: req.file!.id }
          },
        )
        ctx.router.get('/f/:id', { role: 'owner', reauth: true }, (req) =>
          req.files.download(req.params.id!, 'scan'),
        )
        ctx.router.delete('/f/:id', { role: 'owner' }, (req) => req.files.remove(req.params.id!))
      },
    }),
  })

  /**
   * Function: createTestPad call() with upload and download routes
   * Inputs:   upload a PDF; download it with and without the re-check, and from another Space; remove it
   * Expected: the same bytes come back as "scan.pdf"; 403 reauth_required without the re-check;
   *           404 from the other Space; no files after removal
   */
  it('behaves like Pond for files and the re-check', async () => {
    const t = await createTestPad(pad)
    const id = ((await t.call('POST', '/f', { file: PDF })).body as { fileId: string }).fileId
    expect(t.files()).toEqual([id])
    const got = await t.call('GET', `/f/${id}`)
    expect(got.download).toMatchObject({ filename: 'scan.pdf' })
    expect([...got.download!.bytes]).toEqual([...PDF])
    expect((await t.call('GET', `/f/${id}`, { reauthed: false })).body).toEqual({
      error: 'reauth_required',
    })
    expect((await t.call('GET', `/f/${id}`, { spaceId: 'other' })).status).toBe(404)
    await t.call('DELETE', `/f/${id}`)
    expect(t.files()).toEqual([])
  })

  /**
   * Function: createTestPad upload checks and cleanup
   * Inputs:   no file, too large, wrong type, and a handler that throws
   * Expected: 400, 413, 415, and an error with no file left behind
   */
  it('refuses bad uploads and cleans up after a failed handler', async () => {
    const t = await createTestPad(pad)
    expect((await t.call('POST', '/f')).status).toBe(400)
    expect((await t.call('POST', '/f', { file: new Uint8Array(101) })).status).toBe(413)
    expect((await t.call('POST', '/f', { file: new Uint8Array([1, 2, 3]) })).status).toBe(415)
    await expect(t.call('POST', '/f', { file: PDF, query: { fail: '1' } })).rejects.toThrow('boom')
    expect(t.files()).toEqual([])
  })
})
