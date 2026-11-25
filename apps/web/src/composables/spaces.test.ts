import { describe, expect, it } from 'vitest'
import { addableUsers, isLastOwner, roleLabel, type ManagedUser, type Member } from './spaces'

const member = (userId: string, role: Member['role']): Member => ({
  userId,
  username: userId,
  displayName: userId,
  role,
})
const user = (id: string, status: ManagedUser['status'] = 'active'): ManagedUser => ({
  id,
  username: id,
  displayName: id,
  isAdmin: false,
  status,
  totpEnabled: false,
})

describe('isLastOwner', () => {
  /**
   * Function: isLastOwner
   * Inputs:   one owner and one editor; then two owners; a Space with nobody
   * Expected: true only for the sole owner
   */
  it('is true only for the one remaining owner', () => {
    const one = [member('a', 'owner'), member('b', 'editor')]
    expect(isLastOwner(one, 'a')).toBe(true)
    expect(isLastOwner(one, 'b')).toBe(false)
    expect(isLastOwner([member('a', 'owner'), member('b', 'owner')], 'a')).toBe(false)
    expect(isLastOwner([], 'a')).toBe(false)
  })
})

describe('addableUsers and roleLabel', () => {
  /**
   * Function: addableUsers, roleLabel
   * Inputs:   users a (already a member), b (active) and c (sign-in off)
   * Expected: only b can be added; "viewer" reads "Viewer"
   */
  it('offers active people who are not already in the Space', () => {
    const list = addableUsers([user('a'), user('b'), user('c', 'disabled')], [member('a', 'owner')])
    expect(list.map((u) => u.id)).toEqual(['b'])
    expect(roleLabel('viewer')).toBe('Viewer')
  })
})
