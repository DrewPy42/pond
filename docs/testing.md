# Testing

TypeScript checks the *shape* of data. Tests check *behavior*: that splits add up, that a non-member gets a 404, that last year's database still migrates. The goal is simple: **a build we ship to users doesn't break because of something we changed.**

Run everything with `pnpm test`. CI runs it, plus lint, typecheck and build, on every PR, and a failing run blocks the merge.

## What we test, and how

| Kind | Used for | How |
|---|---|---|
| **API integration** (the main workhorse) | Every route and the rules behind it: permissions, validation, ledger invariants, sync de-duplication | Vitest + Supertest against the real Express app and an in-memory SQLite database. Don't mock our own code. |
| **Unit** | Pure logic: money math, rules engine, CSV parsing and column mapping, duplicate detection, transfer matching | Plain Vitest, no database |
| **Migration** | Upgrading from every released schema version without losing data (`CLAUDE.md` rule 9) | Fixture data per schema version, see below |
| **Component** | Shared UI components in `apps/web/src/components/common` | Vitest + Vue Test Utils. Pages that only compose them need fewer tests. |
| **End-to-end smoke** (a handful only) | Critical flows in a real browser: setup, sign-in with TOTP, adding a transaction | Playwright, 5 to 10 tests. Slow, so kept small. Planned; adding it needs approval as a new dependency. |
| **Release gate** (M9) | The shipped image actually works | Before publishing, build for arm64 and amd64, start it, migrate a fixture database, check `/api/health` |

## Every test must say what it checks

A person should be able to read a test and know what broke without reading the code. Each test carries a short comment block with three things:

```ts
describe('parseCents(input)', () => {
  /**
   * Inputs:   "12.34", "-12.3", "$1,234.50", "(5.00)"
   * Expected: 1234, -1230, 123450, -500 (symbols ignored, parentheses mean negative)
   */
  it('turns common money formats into integer cents', () => {
    expect(parseCents('12.34')).toBe(1234)
    ...
  })
})
```

1. **The function (or route) under test** goes in the `describe` name: `parseCents(input)`, `POST /api/auth/login`, `requireSpace`. If the whole file is about one function, say so at the top.
2. **Inputs**: the variables and values the test uses, in plain words ("a 1000-cent transaction with splits [600, 399]").
3. **Expected**: the outcome, and *why* it matters if that isn't obvious ("false; this is the split invariant from `data-model.md`").

The `it(...)` title is a sentence about behavior ("is false when the splits are off by one cent"), not "test 3". For integration tests, name the route and the actors ("viewer", "non-member", "admin") rather than ids.

Good examples to copy: `packages/shared/src/money.test.ts` and `apps/server/src/db/migrations.test.ts`. Older tests get this treatment when they are next touched.

## Rules

- **No feature is done without tests.** Every new route, every piece of money or ledger logic, every sync or rules behavior ships with tests in the same change.
- **Money tests use integer cents.** Include a negative amount and a remainder case.
- **Every new Space-scoped route is declared with `createSpaceRouter`.** The permission suite then covers its 401/404/403 behavior automatically; add tests for the route's own logic.
- **Every schema change ships with a migration test** (next section).
- **Tests are deterministic.** Inject the clock (`ctx.now`) and the login limiter's clock; no real sleeping, no network, no shared state between tests.
- **A bug fix starts with a failing test** that reproduces it.
- **Check that new tests can fail.** Break the code on purpose once and confirm the test goes red (this is how the permission suite was checked).
- **Never put real secrets or real financial data in fixtures.**

## Migration tests

Migrations are forward-only and must run on a database restored from an older backup. The harness in `apps/server/src/db/`:

- `migrationTesting.ts` builds a database at exactly schema version N (`migrateToVersion`), as an older install would look.
- `fixtures.ts` lists one entry per schema version with `seed` (insert realistic rows using raw SQL for that version) and `verify` (assert the rows are intact after upgrading).
- `migrations.test.ts` upgrades **every** version to the latest and runs `verify`. A guard test fails if a migration exists without a fixture.

**When you add a migration:** add the next entry to `SCHEMA_FIXTURES` describing the data at that version, and make sure the earlier fixtures still `verify` after the new migration. If the new migration transforms existing data, add a `verify` that checks the transformed result.

## Where tests live

Next to the code, as `*.test.ts`, with shared helpers in `testing.ts` (server). The server helper builds an app with an injected clock and gives a cookie-jar `Client` that handles sessions and CSRF, so tests read like a user's steps.
