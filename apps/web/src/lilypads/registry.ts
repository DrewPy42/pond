import type { PadClientDefinition, PadClientModule } from '@pond/sdk'

/**
 * The web side of the official LilyPads (docs/lilypad-host-design.md, decision 1): every
 * `lilypads/<id>/src/client.ts` is built into the app. Which pads actually show up is decided by the
 * server (installed AND enabled for the Space), never by this list, so the template pad's code is
 * inert unless the server runs with POND_DEV_PADS=true.
 */
const all = import.meta.glob<{ default: PadClientModule }>('../../../../lilypads/*/src/client.ts', {
  eager: true,
})

export const padClients: Record<string, PadClientDefinition> = Object.fromEntries(
  Object.values(all).map((m) => [m.default.id, m.default.client]),
)
