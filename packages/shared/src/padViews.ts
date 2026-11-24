/** Shapes of the LilyPad management API, shared by the server and the web app. */

export type PadStateName = 'available' | 'running' | 'needs_approval' | 'incompatible' | 'error'

export interface PadListing {
  id: string
  name: string
  version: string
  author: string
  description: string | null
  spaceTypes: ('personal' | 'business')[]
  /** Each permission with its plain-language description, for the install screen. */
  permissions: { permission: string; description: string }[]
  /** False for pads that can't see accounts or transactions. */
  touchesFinances: boolean
  installed: boolean
  state: PadStateName
  /** Why a pad is not running (shown to admins). */
  problem: string | null
  enabledSpaceIds: string[]
}

/** A pad running in a Space (drives the sidebar, dashboard widgets and panels). */
export interface SpacePad {
  id: string
  name: string
  version: string
}

/** An installed pad a Space owner can switch on or off. */
export interface AvailableSpacePad {
  id: string
  name: string
  description: string | null
  touchesFinances: boolean
  enabled: boolean
  hasSettings: boolean
}

export type PadSettingField = {
  key: string
  label: string
  description?: string
  scope: 'space' | 'global'
  value: string | number | boolean
} & (
  | { type: 'boolean'; default: boolean }
  | { type: 'string'; default: string; maxLength?: number }
  | { type: 'integer'; default: number; min?: number; max?: number }
  | { type: 'choice'; default: string; options: { value: string; label: string }[] }
)

export interface PadSettingsView {
  padId: string
  name: string
  fields: PadSettingField[]
}
