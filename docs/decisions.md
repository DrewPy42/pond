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
