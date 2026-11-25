import { definePad } from '@pond/sdk'
import { registerDocuments } from './documents.js'
import { registerPeople } from './people.js'
import { registerProfile } from './profile.js'
import { registerReports } from './reports.js'

export default definePad({
  register(ctx) {
    registerReports(ctx)
    registerProfile(ctx)
    registerPeople(ctx)
    registerDocuments(ctx)
  },
})
