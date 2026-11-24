/** Version of the plugin API this Pond offers. A pad's `pondApi` range must accept it. */
export const CORE_API_VERSION = '1.0.0'

export const PERMISSIONS = [
  'transactions:read',
  'accounts:read',
  'balances:read',
  'spaces:read',
  'secrets:use',
  'files:store',
  // Specified now, built when a pad needs them (docs/lilypad-contract.md, amendment A5).
  'transactions:write',
  'categories:write',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const WORDS: Record<Permission, string> = {
  'transactions:read': 'Read your transactions and categories',
  'accounts:read': 'See your accounts',
  'balances:read': 'See account balances',
  'spaces:read': "See the Space's name and currency",
  'secrets:use': 'Keep private details (like ID numbers) encrypted',
  'files:store': 'Store files you add to it',
  'transactions:write': 'Change your transactions',
  'categories:write': 'Add and change categories',
}

/** Plain-language description of a permission, shown when an admin installs a pad. */
export const describePermission = (p: Permission): string => WORDS[p]

const FINANCIAL: Permission[] = [
  'transactions:read',
  'accounts:read',
  'balances:read',
  'transactions:write',
  'categories:write',
]
/** True when the pad can see or change any financial data. */
export const touchesFinances = (perms: readonly Permission[]): boolean =>
  perms.some((p) => FINANCIAL.includes(p))

/**
 * Supports the two range forms pads need: caret ("^1.0", "^1.2.3": same major, at least that
 * version) and an exact version. Anything else is refused rather than guessed.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!v) return false
  const [vMaj, vMin, vPat] = [Number(v[1]), Number(v[2]), Number(v[3])]
  const caret = /^\^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(range)
  if (caret) {
    const [rMaj, rMin, rPat] = [Number(caret[1]), Number(caret[2]), Number(caret[3] ?? 0)]
    if (vMaj !== rMaj) return false
    return vMin > rMin || (vMin === rMin && vPat >= rPat)
  }
  const exact = /^(\d+)\.(\d+)\.(\d+)$/.exec(range)
  return (
    !!exact && Number(exact[1]) === vMaj && Number(exact[2]) === vMin && Number(exact[3]) === vPat
  )
}
