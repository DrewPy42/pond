import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createCrypto } from '../crypto/index.js'
import { createFakeFileStore } from '../testing/fakeFiles.js'
import { createDiskFileStore, type FileStore } from './store.js'

const roots: string[] = []
const tempRoot = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pond-files-'))
  roots.push(dir)
  return dir
}
afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true })
})

const ref = { padId: 'business', spaceId: 'space-a', fileId: 'file-1' }

/** The same promises must hold for the real disk store and the fake that other tests use. */
describe.each<[string, () => Promise<FileStore>]>([
  ['fake', async () => createFakeFileStore()],
  ['disk', async () => createDiskFileStore(await tempRoot(), createCrypto(randomBytes(32)))],
])('FileStore contract (%s)', (_name, make) => {
  /**
   * Function: put, get, remove
   * Inputs:   some bytes stored under one pad, Space and file id; then removed twice
   * Expected: the same bytes come back; null after removal; removing again is not an error
   */
  it('stores, returns and removes a file', async () => {
    const store = await make()
    await store.put(ref, Buffer.from('hello'))
    expect((await store.get(ref))!.toString()).toBe('hello')
    await store.remove(ref)
    expect(await store.get(ref)).toBeNull()
    await expect(store.remove(ref)).resolves.toBeUndefined()
  })

  /**
   * Function: get (scoping)
   * Inputs:   a file stored in Space A for pad "business"; asked for from Space B and from another pad
   * Expected: null both times
   */
  it('only finds a file through the pad and Space that stored it', async () => {
    const store = await make()
    await store.put(ref, Buffer.from('secret'))
    expect(await store.get({ ...ref, spaceId: 'space-b' })).toBeNull()
    expect(await store.get({ ...ref, padId: 'personal' })).toBeNull()
  })

  /**
   * Function: put, get, remove with ids that try to leave the folder
   * Inputs:   "..", "../x", "a/b", an empty id, an absolute path, as the file, Space or pad id
   * Expected: put is refused; get returns null; remove does nothing
   */
  it('refuses ids that are really paths', async () => {
    const store = await make()
    await store.put(ref, Buffer.from('keep'))
    for (const bad of ['..', '../x', 'a/b', '', '/etc/passwd', 'a\\b', '.hidden']) {
      for (const r of [
        { ...ref, fileId: bad },
        { ...ref, spaceId: bad },
        { ...ref, padId: bad },
      ]) {
        await expect(store.put(r, Buffer.from('x'))).rejects.toThrow()
        expect(await store.get(r)).toBeNull()
        await store.remove(r)
      }
    }
    expect((await store.get(ref))!.toString()).toBe('keep')
  })

  /**
   * Function: removePad
   * Inputs:   files for two pads, then remove one pad's files
   * Expected: that pad's file is gone; the other pad's is untouched
   */
  it('removes one pad’s files only', async () => {
    const store = await make()
    const other = { ...ref, padId: 'personal' }
    await store.put(ref, Buffer.from('a'))
    await store.put(other, Buffer.from('b'))
    await store.removePad('business')
    expect(await store.get(ref)).toBeNull()
    expect((await store.get(other))!.toString()).toBe('b')
  })
})

describe('Disk file store: encryption at rest', () => {
  /**
   * Function: createDiskFileStore.put
   * Inputs:   a file whose contents include a recognizable text
   * Expected: the bytes on disk don't contain that text; the file is readable only by its owner (0600);
   *           no temporary file is left behind
   */
  it('never writes the contents in the clear', async () => {
    const root = await tempRoot()
    const store = createDiskFileStore(root, createCrypto(randomBytes(32)))
    await store.put(ref, Buffer.from('SSN 123-45-6789'))
    const folder = path.join(root, 'business', 'space-a')
    expect(await fs.readdir(folder)).toEqual(['file-1'])
    expect((await fs.readFile(path.join(folder, 'file-1'))).includes('123-45-6789')).toBe(false)
    expect((await fs.stat(path.join(folder, 'file-1'))).mode & 0o077).toBe(0)
  })

  /**
   * Function: createDiskFileStore.get on a file that was changed, moved, or read with another key
   * Inputs:   one flipped byte; the same file copied into another Space's folder; a different master key
   * Expected: each read fails instead of returning anything
   */
  it('refuses a changed or moved file, or the wrong key', async () => {
    const root = await tempRoot()
    const crypto = createCrypto(randomBytes(32))
    const store = createDiskFileStore(root, crypto)
    await store.put(ref, Buffer.from('payroll'))
    const file = path.join(root, 'business', 'space-a', 'file-1')

    await fs.mkdir(path.join(root, 'business', 'space-b'), { recursive: true })
    await fs.copyFile(file, path.join(root, 'business', 'space-b', 'file-1'))
    await expect(store.get({ ...ref, spaceId: 'space-b' })).rejects.toThrow(/decrypt/)

    await expect(createDiskFileStore(root, createCrypto(randomBytes(32))).get(ref)).rejects.toThrow(
      /decrypt/,
    )

    const bytes = await fs.readFile(file)
    bytes[20] = bytes[20]! ^ 1
    await fs.writeFile(file, bytes)
    await expect(store.get(ref)).rejects.toThrow(/decrypt/)
  })
})
