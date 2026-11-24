# Decision log

Newest at the bottom. Add an entry whenever a real decision changes the design.

| Date | Decision | Why |
|---|---|---|
| 2026-11-20 | Name the system **Pond**, plugins **LilyPads**, finance groupings **Spaces** | Fits the WibbitWorks frog theme; Spaces is plain enough for non-accountants |
| 2026-11-20 | Pond is a core + plugins system; the old business manager becomes the Business LilyPad | Personal and business finance share the same ledger |
| 2026-11-20 | Bank data through **SimpleFIN Bridge**, each household with its own account | Read-only, no developer keys, the user pays SimpleFIN directly |
| 2026-11-20 | **TypeScript throughout** (Vue + Express); business_manager's Python backend is ported, not reused | One language for core, SDK and plugin authors |
| 2026-11-20 | **SQLite** | One household, Raspberry Pi; no DB server, one-file snapshots |
| 2026-11-20 | **UUIDs** on every record; keep SimpleFIN IDs | Enables de-duplication and future merge-restore |
| 2026-11-20 | Money as **signed integer cents**, positive = money in | No rounding errors; matches SimpleFIN |
| 2026-11-20 | **Splits** carry Space and category; reports read splits | An account can serve two Spaces without double counting |
| 2026-11-20 | **Open source**: AGPL-3.0 core, MIT SDK and LilyPad template | Protects the core from closed hosted forks; doesn't force a license on plugin authors |
| 2026-11-20 | Multiple users with Space roles; admin sees all; one SimpleFIN token can feed several users | Lets a parent give a child their own Space |
| 2026-11-20 | Manual accounts have full features, no sync | Complete net worth (cash, property, loans) |
| 2026-11-20 | Cross-Space split privacy is opt-in per transaction | Default is convenient; privacy when wanted |
| 2026-11-20 | Admin installs LilyPads; Space owners enable them | Only the admin brings in new code |
| 2026-11-20 | LilyPad trust tiers: official, community verified, unverified. **v1 ships official only** | Isolation is costly on a Pi; no community exists yet |
| 2026-11-20 | No LilyPad dependencies in v1 | Keeps updates simple |
| 2026-11-20 | Backups: passphrase-encrypted, versioned, live snapshots; v1 destinations are download, folder, rclone | Built-in cloud buttons need per-provider OAuth app registration, which is awkward for self-hosted open source |
| 2026-11-20 | Restore v1 overwrites everything; merge later | Merge is complex; stable IDs keep it possible |
| 2026-11-20 | Master key in a file by default; startup passphrase optional | Pond recovers from power outages unattended; extra protection for those who want it |
| 2026-11-20 | v1 is home-network only; Tailscale later | Smaller attack surface for the first release |
| 2026-11-20 | SSN/EIN masked; password re-entry to reveal | Protects an unattended logged-in screen |
| 2026-11-20 | v1 updates: notice + documented command; one-click later | One-click update with rollback is the hardest feature; it gets its own phase |
| 2026-11-20 | CSV import in v1; PDF import with the AI Assistant later | business_manager's PDF parsing used a local model that can't run on a Pi |
| 2026-11-20 | Passkeys deferred; v1 uses password + TOTP | WebAuthn needs HTTPS on a real hostname, which a home-network-only install usually lacks |
| 2026-11-20 | Backups use the age format and include the master key inside the encryption | Can be decrypted with standard tools; restores onto a new install can still read encrypted fields |
| 2026-11-20 | **Vuetify 3** as the only UI component library; brand palette as a Vuetify theme | Tables, forms, nav drawer and dark mode out of the box; gloxV's Bootstrap + Vuetify mix isn't repeated |
| 2026-11-20 | Brand green/teal are accents only; navy text on green buttons; dark teal links; contrast-safe money colors | The bright brand colors score ~2.2:1 with white text, below the 4.5:1 WCAG minimum |
| 2026-11-20 | Redraw the WibbitWorks logo as vector SVG; add a Pond product mark | The existing logo is a raster PNG on a cream background, unusable on gray or dark themes |
| 2026-11-20 | M0 toolchain: pnpm 12, Node 22 LTS floor, TypeScript ~5.9 (vue-tsc doesn't support TS 7), Vuetify ^3 (the registry default is now 4), Vitest, ESLint + Prettier, uuid for UUIDv7 | Matches the stack in CLAUDE.md; pinned where the latest major breaks a stated rule or tool |
| 2026-11-20 | `settings.scope_id` is `NOT NULL DEFAULT ''` (empty = global) instead of nullable | SQLite treats NULLs as distinct in a primary key, so a nullable column would allow duplicate global settings |
| 2026-11-20 | Theme `error` fill is `#EE6F6F`, a lightened brand red; `#E85A5A` stays for icons and borders | Navy text on `#E85A5A` is 4.15:1, below WCAG AA; a unit test now guards every text/background pair |
| 2026-11-20 | gloxV has no brand tokens to port (its Vuetify setup uses defaults); the palette in CLAUDE.md is the source of truth | Closes the open item in `scope-v1.md` |
| 2026-11-20 | First-run setup code lives in memory and is printed to the server console at startup while no user exists; a restart issues a new one | Nothing to store or leak; physical access to the server is the trust anchor |
| 2026-11-20 | New admins get a session immediately but can only reach TOTP enrollment (`403 totp_enrollment_required` elsewhere) until they confirm a code | Satisfies "TOTP required for admins" without a chicken-and-egg step in setup |
| 2026-11-20 | Added `recovery_codes` table and `users.totp_enabled_at`, `sessions.csrf_hash` / `absolute_expires_at` | The spec lists recovery codes, CSRF and the 30-day limit but no columns for them |
| 2026-11-20 | Every Space-scoped route is declared through `createSpaceRouter`, which records it so tests can assert the non-member 404 rule for all of them | Makes "a test for every route" automatic instead of a checklist |
| 2026-11-20 | Only admins create Spaces and users in v1; Space owners manage members and settings | Matches "admin installs, owners manage"; user self-signup is out of scope |
| 2026-11-20 | Argon2id at 19 MiB / t=2 / p=1 (OWASP minimum profile); login throttling is in-memory per IP and per username | Fits a Pi 4; a single node needs no shared limiter. TOTP codes are not yet replay-blocked within their 30 s window (known gap) |
| 2026-11-21 | Build the UI from shared common components, composables and stores; extract on second use; LilyPads reuse them through the SDK | Many screens plus plugins will otherwise duplicate inputs, tables and dialogs; gloxV's `components/common` shows the set worth sharing |
| 2026-11-21 | TOTP enrollment shows a QR code, drawn client-side from the `otpauth://` URI with the `qrcode` package (SVG data URL in an `<img>`) | Scanning beats typing a 32-character key; no canvas, no `v-html`, nothing sent to a third party |
| 2026-11-21 | Test strategy: API integration tests as the workhorse, unit tests for pure logic, migration fixtures per schema version, a few Playwright smoke tests, a release-gate image check. Every test states function, inputs and expected outcome | Catches behavior TypeScript can't; protects users on upgrade; keeps tests readable by non-authors. See `docs/testing.md` |
| 2026-11-22 | Functionality tests use mock data and in-memory fake repositories, not a database; routes and services depend on repository interfaces, with Drizzle only inside the real repositories. Only repository-contract and migration tests use SQLite | Tests focus on our logic, run faster and fail for clearer reasons. Supersedes the in-memory-SQLite integration approach from 2026-11-21; contract tests stop fakes drifting from real behavior |
| 2026-11-22 | M1 refactored onto repositories (`apps/server/src/repos`): interfaces, Drizzle implementations, in-memory fakes, and a shared contract test; ESLint forbids Drizzle/`db` imports in routes, middleware, auth, audit and app | Implements the mock-data testing decision; keeps data access in one layer for all later milestones |
| 2026-11-22 | M2: a transaction's splits may land in other Spaces only if the actor can edit each of them; only the account's own Space can edit, delete, link or change privacy of a transaction | Keeps cross-Space splits safe without a request/approval flow, which v1 doesn't need |
| 2026-11-22 | Soft delete for manual transactions (`status = removed`); bank-fed and CSV rows can't be deleted by hand | Preserves history for restores and sync reconciliation (data-model.md) |
| 2026-11-22 | Changing the amount of a transaction that has several splits requires sending new splits; a lone split follows the amount; linked transfers can't change amount until unlinked | Never guesses how to re-divide money; keeps transfer pairs equal and opposite |
| 2026-11-22 | Business seed category "Other Expenses" uses Schedule C Line 27a (business_manager had Line 48) | Line 48 is the Part V total that carries to 27a; 27a is where the amount is reported |
| 2026-11-22 | `accounts.connection_id` and `transactions.import_batch_id` are added by the M3/M4 migrations instead of now | Their parent tables don't exist yet; SQLite can add a nullable referencing column later |
| 2026-11-22 | M3: no new dependencies; SimpleFIN uses Node's built-in `fetch` and a plain in-process timer for the schedule | Keeps the install small for a Pi; the scheduler only needs "run every N hours, never overlapping" |
| 2026-11-22 | SimpleFIN URLs must be public https (port 443, no private ranges, no redirects) | An admin pastes the claim URL and the server fetches it; this keeps Pond from being pointed at the home network |
| 2026-11-22 | Setup Token is claimed first and the connection saved before discovery; if discovery fails the connection is kept with the error | The token is single-use, so losing the resulting Access URL would force the user to create a new token |
| 2026-11-22 | Discovered bank accounts start unassigned, hidden and not syncing; an admin assigns a Space, which turns syncing on. An account with history can't be moved to another Space yet | Matches architecture.md; moving history between Spaces is a later feature |
| 2026-11-22 | Added `transactions.user_edited` and `transactions.superseded_by` | The spec needs "unless the user edited it" and to avoid matching one pending transaction to two posted ones, but listed no column for either |
| 2026-11-22 | Defaults: first sync 90 days, then 14 days of overlap, automatic sync every 12 h (clamped 4 to 24), manual sync at most every 5 min | The protocol page documents no limits; stay conservative until checked against a real account (open item in scope-v1.md) |
| 2026-11-22 | Bank-fed accounts reject hand-typed transactions; a bank-fed account with unreadable data is skipped whole and its window is not advanced | Prevents duplicates and silent data gaps |
| 2026-11-22 | Rule text "matches" is a wildcard pattern (`*`, `?`), not a regular expression | A user-written regex can cause catastrophic backtracking and freeze the single Node process; the wildcard matcher is linear-ish and safe |
| 2026-11-22 | Matching rules all apply in priority order (lowest number first); each kind of change is made by the first rule that asks for it | Predictable: a higher-priority rule is never overridden, but different rules can still contribute different changes |
| 2026-11-22 | Added `rules.created_by`; "move to Space" and "link as transfer" are re-checked against that person's permissions each time a rule runs | A rule must not outlive the permissions of whoever wrote it |
| 2026-11-22 | Rules run on new transactions and via an explicit "Run on uncategorized"; never on edited, removed or multi-split transactions | Matches data-model.md ("never on ones a user has edited") and avoids rewriting people's work |
| 2026-11-22 | CSV import is stateless on the server: preview (no writes), then commit with the same file; batches are stored once with status `done` | No stored uploads to protect or clean up; the review screen state lives in the browser |
| 2026-11-22 | CSV duplicate detection matches by count against what the account already holds | Two real identical purchases on one day are not both dropped as duplicates |
| 2026-11-22 | A small built-in CSV reader instead of a library | A CSV reader is ~100 lines; avoids a dependency (rule 10) and lets us enforce size and column limits |
| 2026-11-22 | Product principle: simple by default, flexible underneath (works with no setup, few concepts, plain words, options only when needed) | The owner has been put off by complicated budgeting software; this is the main thing Pond should do differently. Recorded in `CLAUDE.md` |
| 2026-11-22 | Personal Finance LilyPad v1 = simple monthly category budgets (with a "suggest from the last 3 months" start), savings goals (linked account or recorded contributions), dashboard widgets. No rollover, envelope or zero-based budgeting | Settles the scope-v1 open item; keeps the pad small so it mainly proves the plugin API |
| 2026-11-22 | Bills (recurring-charge detection, upcoming bills, subscriptions) deferred to a v2 LilyPad; notes in `future.md` | The owner has more ideas for it than fit v1 and wants the Personal Finance pad kept simple; it suits its own LilyPad |
| 2026-11-22 | Reimbursables deferred to v2 | The owner wants to understand the need before designing it; the data fields stay unused for now |
| 2026-11-22 | LilyPad host: pad routes are Space-scoped (`/api/spaces/:spaceId/lilypads/<id>/...`) through `createSpaceRouter`; `core` is a per-request/job scoped object with no `spaceId` argument | Reuses the shared auth/Space middleware (rule 5) and gets every pad route into the permission suite automatically; a pad can't reach another Space. Amendments A1 and A2 in `lilypad-contract.md` |
| 2026-11-22 | LilyPads load from a build-time registry behind a `PadSource` interface; optional pads ship in the image but stay off until an admin installs them; updates can add pads that appear as available | Simplest v1 packaging; the swap to runtime loading is contained in one interface. Amendment A7 |
| 2026-11-22 | Host contract changes: structured schedules instead of cron, generated settings UI, core write APIs deferred, `splits.sum` primitive, JSON-serializable `ctx` rule | Smaller, safer, testable surface. Amendments A3 to A6. Pad data access (table API vs query builder) is still undecided (A8) |
| 2026-11-22 | LilyPad data access is a table API (find/findOne/insert/insertMany/update/delete/count, simple filters, text search, `or` groups, declarative migrations, automatic Space scoping), not a query builder or raw SQL, with no SQL escape hatch for official pads either | Safest and easiest to test on fakes; extend by adding operations (non-breaking) rather than removing raw SQL later (breaking). Also covers non-financial pads such as a CRM. Amendment A8 |
| 2026-11-22 | M5a built: host, SDK, example pad. Pad settings are inline in the manifest; management routes live under `/api/lilypads` (admin) and `/api/spaces/:id/pads` (owners); `lilypads/template` loads only with `POND_DEV_PADS=true` outside production | Keeps one manifest file per pad; example pad can't appear on a real install. See "As built (M5a)" in `lilypad-contract.md` |
| 2026-11-22 | Pads that fail repeatedly are auto-disabled (503, audited) instead of retried forever | One broken pad must not degrade the money data or fill a Pi's log |
| 2026-11-22 | `reports.sumSplits` excludes removed transactions, linked transfers and transfer-kind categories by default | One way to total money for core Reports and pads; transfers would otherwise double count |
