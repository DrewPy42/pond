import type { PadManifest, SettingField } from '@pond/sdk'
import type { Repos } from '../repos/types.js'

/**
 * Pad settings (docs/lilypad-host-design.md): the manifest declares the fields, the host stores
 * values in the core `settings` table under `lp.<padId>.<key>` and draws the settings screen.
 */
export const settingKey = (padId: string, key: string) => `lp.${padId}.${key}`

export type SettingValue = string | number | boolean

export class SettingError extends Error {
  constructor(
    public code: 'unknown_setting' | 'invalid_setting' | 'wrong_scope',
    message: string,
  ) {
    super(message)
  }
}

export function fieldFor(manifest: PadManifest, key: string): SettingField {
  const f = manifest.settings.find((s) => s.key === key)
  if (!f) throw new SettingError('unknown_setting', `Unknown setting "${key}"`)
  return f
}

/** Checks a value against its field. Returns it (trimmed, for text) or throws. */
export function checkSettingValue(f: SettingField, value: unknown): SettingValue {
  const bad = () => new SettingError('invalid_setting', `Bad value for "${f.label}"`)
  switch (f.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw bad()
      return value
    case 'string': {
      if (typeof value !== 'string') throw bad()
      const v = value.trim()
      if (v.length > (f.maxLength ?? 500)) throw bad()
      return v
    }
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw bad()
      if ((f.min !== undefined && value < f.min) || (f.max !== undefined && value > f.max))
        throw bad()
      return value
    case 'choice':
      if (typeof value !== 'string' || !f.options.some((o) => o.value === value)) throw bad()
      return value
  }
}

const where = (f: SettingField, spaceId: string) =>
  f.scope === 'global' ? (['global', ''] as const) : (['space', spaceId] as const)

export function getSetting(
  repos: Repos,
  manifest: PadManifest,
  spaceId: string,
  key: string,
): SettingValue {
  const f = fieldFor(manifest, key)
  const [scope, id] = where(f, spaceId)
  const stored = repos.settings.get(scope, id, settingKey(manifest.id, key))
  if (stored === undefined) return f.default
  try {
    return checkSettingValue(f, stored)
  } catch {
    return f.default // a stored value that no longer fits falls back to the default
  }
}

export function setSetting(
  repos: Repos,
  manifest: PadManifest,
  spaceId: string,
  key: string,
  value: unknown,
): void {
  const f = fieldFor(manifest, key)
  const [scope, id] = where(f, spaceId)
  repos.settings.set(scope, id, settingKey(manifest.id, key), checkSettingValue(f, value))
}

/** Fields of one scope with their current values, for the generated settings screen. */
export function describeSettings(
  repos: Repos,
  manifest: PadManifest,
  spaceId: string,
  scope: 'space' | 'global',
) {
  return manifest.settings
    .filter((f) => f.scope === scope)
    .map((f) => ({ ...f, value: getSetting(repos, manifest, spaceId, f.key) }))
}
