/** Words and small rules for the Spaces and users screens. */

export type SpaceRole = 'owner' | 'editor' | 'viewer'

export const ROLE_ITEMS: { value: SpaceRole; title: string; subtitle: string }[] = [
  { value: 'owner', title: 'Owner', subtitle: 'Everything, including who is in the Space' },
  { value: 'editor', title: 'Editor', subtitle: 'Add and change accounts and transactions' },
  { value: 'viewer', title: 'Viewer', subtitle: 'Look, but not change' },
]
export const roleLabel = (role: SpaceRole): string =>
  ROLE_ITEMS.find((r) => r.value === role)!.title

export const SPACE_TYPE_ITEMS = [
  { value: 'personal', title: 'Personal', subtitle: 'Household money' },
  { value: 'business', title: 'Business', subtitle: 'Money for a business' },
]

export interface Member {
  userId: string
  username: string
  displayName: string
  role: SpaceRole
}

/** The only owner can't be removed or made something else; the server enforces this too. */
export const isLastOwner = (members: readonly Member[], userId: string): boolean => {
  const owners = members.filter((m) => m.role === 'owner')
  return owners.length === 1 && owners[0]!.userId === userId
}

export interface ManagedUser {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
  status: 'active' | 'disabled'
  totpEnabled: boolean
}

/** People who can still be added to a Space: active, and not already in it. */
export const addableUsers = (
  users: readonly ManagedUser[],
  members: readonly Member[],
): ManagedUser[] =>
  users.filter((u) => u.status === 'active' && !members.some((m) => m.userId === u.id))
