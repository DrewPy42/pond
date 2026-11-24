import { z } from 'zod'
import { PERMISSIONS } from './permissions.js'

/**
 * A pad's manifest (`lilypad.json`), validated at start-up. The trust tier is not declared here:
 * it comes from where the pad was loaded (v1: shipped in the image, so "official").
 */
const base = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,29}$/),
  label: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  /** `space` settings are per Space (changed by Space owners); `global` ones are admin-only. */
  scope: z.enum(['space', 'global']).default('space'),
})

export const settingFieldSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('boolean'), default: z.boolean() }),
  base.extend({
    type: z.literal('string'),
    default: z.string().max(500),
    maxLength: z.number().int().min(1).max(500).optional(),
  }),
  base.extend({
    type: z.literal('integer'),
    default: z.number().int(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
  base.extend({
    type: z.literal('choice'),
    default: z.string(),
    options: z
      .array(z.object({ value: z.string(), label: z.string() }))
      .min(1)
      .max(20),
  }),
])
export type SettingField = z.infer<typeof settingFieldSchema>

export const manifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,29}$/, 'lowercase letters, numbers and dashes'),
  name: z.string().min(1).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  author: z.string().min(1).max(80),
  license: z.string().min(1).max(40),
  description: z.string().max(300).optional(),
  /** Semver range of the plugin API this pad supports, e.g. "^1.0". */
  pondApi: z.string(),
  /** Space types the pad can be turned on for. */
  spaceTypes: z.array(z.enum(['personal', 'business'])).min(1),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
  /** Shown only when Pond runs with development pads enabled (the template pad). */
  devOnly: z.boolean().optional(),
  settings: z.array(settingFieldSchema).max(30).default([]),
})
export type PadManifest = z.infer<typeof manifestSchema>
