/** `pond admin reset-password <username> [--remove-2fa]` */
import fs from 'node:fs'
import { loadConfig } from '../config.js'
import { latestSchemaVersion, openDb, schemaVersion } from '../db/index.js'
import { newId } from '../db/ids.js'
import { createDrizzleRepos } from '../repos/drizzle.js'
import { resetPassword } from './resetPassword.js'

const USAGE = 'Usage: pond admin reset-password <username> [--remove-2fa]'

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const args = process.argv.slice(2).filter((a) => a !== '--')
const removeTwoFactor = args.includes('--remove-2fa')
const [group, command, username, ...extra] = args.filter((a) => a !== '--remove-2fa')
if (group !== 'admin' || command !== 'reset-password' || !username || extra.length) fail(USAGE)

const { dbPath } = loadConfig()
if (!fs.existsSync(dbPath)) fail(`There is no Pond database at ${dbPath}. Check POND_DATA_DIR.`)
const db = openDb(dbPath)
try {
  // This command never changes the database's structure; only Pond itself does that.
  if (schemaVersion(db) !== latestSchemaVersion())
    fail('This database is from a different version of Pond. Start Pond once, then try again.')
  const result = await resetPassword(
    { repos: createDrizzleRepos(db), now: () => new Date(), newId },
    { username, removeTwoFactor },
  )
  if (!result) fail(`There is no user called "${username}".`)
  console.log(`\n  Temporary password: ${result.temporaryPassword}\n`)
  console.log('  It is shown only once. Sign in with it, then change it in Settings.')
  console.log('  Everywhere this user was signed in has been signed out.')
  if (result.removedTwoFactor)
    console.log(
      result.isAdmin
        ? '  Their authenticator is off. They must set it up again at the next sign-in.'
        : '  Their authenticator is off.',
    )
  if (result.disabled) console.log('  Note: this account is disabled, so it still cannot sign in.')
} finally {
  db.close()
}
