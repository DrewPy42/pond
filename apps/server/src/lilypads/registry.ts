import { padModule as templatePad } from '@pond/lilypad-template'
import type { PadModule } from '@pond/sdk'
import type { PadSource } from './host.js'

/**
 * The v1 PadSource: a list of the official pads built into this Pond (docs/lilypad-host-design.md,
 * decision 1). Add a pad by importing its module here. Nothing else knows how pads are found, so a
 * runtime loader can replace this one day by implementing `PadSource`.
 *
 * The template pad is marked `devOnly`, so the host offers it only when POND_DEV_PADS=true.
 */
const officialPads: PadModule[] = [templatePad]

export const registrySource: PadSource = { list: () => officialPads }
