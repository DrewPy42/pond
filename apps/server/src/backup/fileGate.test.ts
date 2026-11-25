/** createGatedFileStore(inner): holding back file deletions while a backup copies the files. */
import { describe, expect, it } from 'vitest'
import { createFakeFileStore } from '../testing/fakeFiles.js'
import { createGatedFileStore } from './fileGate.js'

const ref = (fileId: string) => ({ padId: 'business', spaceId: 's1', fileId })
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('createGatedFileStore(inner).hold()', () => {
  /**
   * Inputs:   two holds; a file removed while both are open
   * Expected: it stays until the last hold ends, so a snapshot never points at a missing file;
   *           releasing one hold twice doesn't count twice
   */
  it('keeps a removed file until every backup has finished', async () => {
    const gate = createGatedFileStore(createFakeFileStore())
    await gate.put(ref('a'), Buffer.from('a'))
    const first = gate.hold()
    const second = gate.hold()
    await gate.remove(ref('a'))
    first()
    first()
    await tick()
    expect(await gate.get(ref('a'))).not.toBeNull()
    second()
    await tick()
    expect(await gate.get(ref('a'))).toBeNull()
  })

  /**
   * Inputs:   an app's files removed while a hold is open
   * Expected: the removal waits for the release, then happens
   */
  it("waits to remove an app's files", async () => {
    const gate = createGatedFileStore(createFakeFileStore())
    await gate.put(ref('a'), Buffer.from('a'))
    const release = gate.hold()
    let done = false
    const removing = gate.removePad('business').then(() => (done = true))
    await tick()
    expect(done).toBe(false)
    release()
    await removing
    expect(await gate.get(ref('a'))).toBeNull()
  })
})
