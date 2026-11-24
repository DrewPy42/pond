import { definePadModule, manifestSchema } from '@pond/sdk'
import manifest from '../lilypad.json'
import init from './migrations/0001_init.js'
import server from './server.js'

/** What Pond's registry imports. */
export const padModule = definePadModule({
  manifest: manifestSchema.parse(manifest),
  migrations: [init],
  server,
})
