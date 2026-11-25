/** What backup and restore need from the database. SQLite in production, a fake in tests. */
export interface DbInfo {
  /** Number of core migrations applied. */
  schemaVersion: number
  /** Each LilyPad's applied migrations. */
  padMigrations: Record<string, string[]>
  /** Rows per table. */
  counts: Record<string, number>
}

export interface BackupDb {
  /** A consistent copy of the live database, safe while Pond is in use. */
  snapshot(target: string): Promise<void>
  /** Reads a database file that is not in use. */
  inspect(path: string): DbInfo
  /** Problems SQLite itself finds in a database file; empty when it is sound. */
  integrityProblems(path: string): string[]
  /** Every stored encrypted value: columns ending in `_enc`, and encrypted settings. */
  encryptedValues(path: string): Iterable<string>
  /** How many core migrations this version of Pond has. */
  latestSchemaVersion(): number
  /** Runs core migrations on a throwaway copy, to find out before a restore that they work. */
  trialMigrate(path: string): void
}
