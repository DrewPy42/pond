import { randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * One-time first-run code. Generated at startup while no admin exists and printed to the
 * server log; creating the first admin requires it. Held in memory only, so a restart issues a
 * new one. It is consumed on use.
 */
export class SetupCode {
  private code: string | null

  constructor(needed: boolean) {
    this.code = needed ? SetupCode.generate() : null
  }

  private static generate(): string {
    const hex = randomBytes(6).toString('hex').toUpperCase()
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8)}`
  }

  get active(): boolean {
    return this.code !== null
  }

  /** The code to print to the console. Null once setup is done. */
  reveal(): string | null {
    return this.code
  }

  verify(presented: string): boolean {
    if (!this.code) return false
    const a = Buffer.from(presented.trim().toUpperCase())
    const b = Buffer.from(this.code)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  consume(): void {
    this.code = null
  }
}
