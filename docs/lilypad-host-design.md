# LilyPad host design (M5): proposal for review

**Status: proposal, nothing built yet.** This turns `lilypad-contract.md` into a concrete design for how Pond loads, runs, secures and tests LilyPads. It lists the places where I'd change the contract, and ends with the decisions I need from you.

## Decisions so far (2026-11-22)

- **1. Build-time registry: approved**, on the condition that changing it later stays easy. See "Keeping the registry swappable" below.
- **2. Space-scoped pad routes: approved**, to be documented with reasons (done: amendment A1 in `lilypad-contract.md`). Route and security changes get explicit review.
- **3. Table API: approved** (option A). Pads query their own tables only through the table API; we extend it when real pads need more. No raw SQL escape hatch.
- **4. Install flow: approved**: the admin installs (reviewing permissions), Space owners enable per Space. Optional pads ship in the image but stay off until installed, and updates can add new pads that appear as available.

## What the host has to do

- Load **official** pads (shipped in the image) and let an admin install them and Space owners turn them on.
- Give a pad a narrow, permission-checked view of core data, and its own tables, and nothing else.
- Never let a pad break core: a pad that fails is switched off, core carries on.
- Stay **simple to use** (`personal-finance-pad.md`): installing and enabling a pad is two clicks.
- Obey the hard rules in `CLAUDE.md`: every route goes through the shared auth/Space middleware (rule 5), pads never touch core tables (rule 6), secrets go through the crypto module (rule 7), zod at the boundary (rule 8), tests use fakes, not the database (rule 11).
- Keep the door open for isolated, community pads later **without changing pad code** (contract, "v1 boundaries").

## Decisions at a glance

| # | Question | Recommendation | Why | Alternative |
|---|---|---|---|---|
| 1 | How are pads loaded in v1? | **Build-time registry**: a generated list of the official pads in the repo, used by both server and web | Pads ship in the image anyway; fully type-checked; no runtime module loading or CSP trouble; simplest packaging for M9 | Runtime `import()` from `lilypads/` (needed only once third-party pads exist; swap in later behind the same interface) |
| 2 | Where do pad routes live? | **`/api/spaces/:spaceId/lilypads/<id>/...`**, declared through `createSpaceRouter` | Pad routes get auth, 404-for-non-members and roles for free, and the permission suite tests every pad route automatically | `/api/lilypads/<id>/...` as in the contract (needs its own Space resolution and its own tests) |
| 3 | How do pads read core data? | A **scoped `core` facade** passed to each handler and job (`req.core`), bound to one Space and one acting user | A pad can't name another Space; permissions are checked in one place; serializable for later isolation | A global `ctx.core` that looks up the caller implicitly |
| 4 | How do pads store their own data? | A small **table API** (find / insert / update / delete / count) plus **declarative migrations**, with automatic Space scoping | Not raw SQL or Drizzle: serializable, testable on fakes, safe by construction, and a pad bug can't leak rows across Spaces | `ctx.db(table)` as a full query builder (raw Drizzle handle: powerful but unsafe and not remote-able) |
| 5 | Schedules | A small **structured schedule** (`daily` / `weekly` / `monthly`), with catch-up after downtime | No cron parser to maintain; clearer; a Pi that was off on the 1st still runs the monthly job | Cron strings (needs a parser dependency) |
| 6 | Pad settings UI | **Generated from the pad's settings schema** | Pad authors write no settings screens; every pad's settings look the same | Pad supplies its own Vue component |
| 7 | Core write access for pads | **Read-only in v1**; write APIs (`transactions:write`, `categories:write`) are specified but built when a pad needs them | Neither v1 pad writes core data; smaller surface, less to secure | Build all of `ctx.core` now |

## Overview

```
                     web (Vue)                              server (Express)
        ┌──────────────────────────────┐     ┌─────────────────────────────────────────────┐
        │ shell: sidebar, dashboard,   │     │ core routes ──► createSpaceRouter ──► repos │
        │ Space settings, reports      │     │ pad routes  ──►   (same middleware)         │
        │  ▲ registered extension      │     │      │                                      │
        │  │ points (sidebar, widget,  │     │ PadHost: manifests, install/enable state,   │
        │  │ panels, settings tab)     │     │   migrations, per-Space gating              │
        │ pad client code (generated   │     │      │                                      │
        │ registry, same bundle)       │     │   PadContext (per pad)                      │
        └──────────────────────────────┘     │    ├ router (Space-scoped routes)           │
                                             │    ├ core facade ► core services ► repos    │
                                             │    ├ table store ► PadTableRepo (lp_<id>_*) │
                                             │    ├ events  ◄── EventBus ◄── core services │
                                             │    ├ jobs    ◄── PadScheduler               │
                                             │    └ settings, secrets, audit, log          │
                                             └─────────────────────────────────────────────┘
```

## Details

### Loading and lifecycle
- **Manifest** (`lilypad.json`) is validated with zod at startup (id, version, `pondApi` range, `spaceTypes`, `permissions`, entries). Anything invalid is refused with a clear log line.
- **Registry:** a generated file (`apps/server/src/lilypads.generated.ts`, and a web equivalent) imports each `lilypads/*` entry. The host asks the registry "which pads exist", so replacing it with a runtime loader later changes nothing else.
- **States** (stored in `lilypad_installs`): *available* (shipped, not installed) → *installed* (admin approved the permission list) → *enabled per Space* (`lilypad_space_enablement`, by Space owners, only for the pad's allowed Space types). Installed pads that fail to load show as *error* with the reason.
- **Startup order:** check `pondApi` range and that granted permissions cover the manifest (else *needs re-approval*, stays off) → automatic backup hook (the real backup arrives in M8; M5 calls a no-op hook) → run pending migrations (recorded in `lilypad_migrations`) → call `register(ctx)`.
- **Isolation:** every call into a pad (register, route handler, event handler, job) runs in a try/catch. A failure is logged against the pad, audited, counted, and after repeated failures the pad is switched off. Core never crashes because of a pad.
- **Admin UI (Settings, admin only):** a list of available pads, an **Install** button that shows the permissions in plain words ("Read your accounts and transactions"), and Uninstall (keep or delete the pad's data). **Space owners** get one switch per Space: "Use Personal Finance in this Space".

### Keeping the registry swappable
Everything that needs to know which pads exist goes through one interface, `PadSource` (`list()`, `loadServer(id)`, `loadClient(id)`). v1 has one implementation, a generated list of the official pads in the repo. Nothing else depends on how pads are found, and pad code only ever talks to the SDK. Later, a runtime loader that reads pads from a folder can implement the same interface:
- **Server side:** a small change (dynamic `import()` of the pad's server entry).
- **Web side:** the harder half. Pad client code would be loaded at runtime, so Vue, Vuetify and the SDK UI components must be shared with the pad instead of bundled into it. That work is contained in the web `PadSource`; pads themselves don't change.
- **Optional pads** need nothing extra: they are ordinary registry entries that stay *available* until an admin installs them. A new pad arriving in an update is just a new registry entry.

### Routes
- A pad declares `ctx.router.get('/budgets', { role: 'viewer', query: schema }, handler)`. The host mounts it at `/api/spaces/:spaceId/lilypads/<id>/budgets` through `createSpaceRouter`, adding one gate: the pad must be installed **and** enabled for that Space, otherwise 404. A route must declare its minimum role (there is no default), and zod schemas for body and query; the host validates before the handler runs.
- Every pad route is recorded in the same registry the permission suite already reads, so each one is automatically tested for 401, non-member 404 and role 403. No extra test code per pad.
- The handler gets `req.user`, `req.space`, `req.body`/`req.query` (validated), and `req.core`/`req.db`/`req.settings` (bound to this Space).

### The core facade (`req.core`, `job.core`)
- Created per request or job with `{ padId, grants, spaceId, actor }`. Methods have **no `spaceId` parameter**: the Space is fixed by the scope, so a pad cannot ask about another Space.
- Each call checks: the pad was granted the permission (`transactions:read`, `accounts:read`, `balances:read`, `spaces:read`), the pad is enabled for the Space, and (for requests) the acting user's role. Jobs and events run as the Space itself, with only the pad's grants.
- It calls the same core services the web app uses, and returns the same **privacy-filtered views** (`viewTransaction`), so a pad in Space B sees only the shared view of a cross-Space transaction.
- **v1 read API:** `accounts.list`, `categories.list` (with `taxLine`), `transactions.list / get`, `balances.latest / history`, `spaces.get`, and one reporting primitive, **`splits.sum({ from, to, groupBy: 'category' | 'month' | 'category_month', kind? })`**. Sums read splits, exclude transfers and removed transactions, and are integer cents. The same primitive will power core Reports in M7, so there is one way to total money.
- **Not built until a pad needs it:** `transactions:write`, `splits.set`, `categories:write`.

### Pad data: table API and migrations
- Tables are named `lp_<padId>_<name>` (data-model.md) and are reached only through `req.db.table('budgets')` (the host adds the prefix; any other name throws):
  `find({ where, orderBy, limit })`, `findOne`, `insert`, `insertMany`, `update({ where }, patch)`, `delete({ where })`, `count({ where })`.
  `where` supports equality and `ne / gt / gte / lt / lte / in / isNull`, plus the text operators `contains` and `startsWith` (case-insensitive), combined with AND, and an `or` group of conditions. The text operators and `or` exist so a pad can offer search (a contact list, say) without any raw SQL. Column and table names are checked against the pad's own declared schema, and values are bound parameters, so there is no string-built SQL (rule 8).
- **Automatic Space scoping:** tables declared `scope: "space"` (the default) get `space_id = <this Space>` added to every query and filled on every insert. A pad bug cannot read or write another Space's rows.
- **Migrations are declarative and forward-only**, written with a small builder (`createTable`, `addColumn`, `createIndex`), not raw SQL, because raw SQL cannot be policed without parsing it. Column types: `text`, `integer` (use for cents), `boolean`, `json`. No floats. Primary key `id` is a UUIDv7 text value generated by `ctx.newId()`. No foreign keys into core tables.
- Implemented behind a `PadTableRepo` interface with a Drizzle/SQLite version and an in-memory fake, proven by the same contract-test approach as the other repositories.

### Events
- A small in-process **`EventBus`** in core. Core services emit after the database change has committed: `transaction.created`, `transaction.updated`, `split.changed` (from manual edits, sync and CSV import), plus `sync.completed`, `account.added`, `space.created`. (`backup.before` arrives with M8.) Payloads are ids plus the Space id; pads fetch details through the facade, so permissions apply.
- A pad only receives events for Spaces where it is enabled. Handlers run asynchronously, one failing never affects the others or the core operation that triggered the event.

### Jobs
- `ctx.jobs.schedule('rollup', { monthly: { day: 1, at: '06:00' } }, handler)`; also `daily` and `weekly`. The job runs once **per enabled Space**, scoped to it. The host records the last run per pad, job and Space (`lilypad_job_runs`), so a restart doesn't repeat a run and a missed run (Pi was off) happens at the next start. The clock is injected, so tests need no real waiting.

### Settings, secrets, audit, log
- **Settings:** a JSON schema in the manifest defines global and per-Space settings. The host stores them in the existing `settings` table under `lp.<id>.<key>`, validates them, and draws the settings screen itself.
- **Secrets:** `ctx.secrets.encrypt / decrypt` through the core crypto module (needs `secrets:use`); never logged. Needed by the Business pad (SSN, EIN); built in M5 because it is tiny.
- **Files** (`files:store`, `/data/files/<padId>/`) are built in M6 when the Business pad needs documents.
- **Audit and log:** `ctx.audit` writes entries attributed to the pad (`actor_type = lilypad`), with the same secret scrubbing; `ctx.log` is a child logger with the pad id and the redaction list.

### The web side
- Official pads' client code is part of the web build, registered through a generated registry (decision 1). A pad's client entry calls `definePadClient({ sidebar, routes, dashboardWidgets, reportPages, transactionPanel, accountPanel })` with Vue components. The shell shows a pad's items only in Spaces where it is enabled (it asks `GET /api/spaces/:id/lilypads`).
- Pads use the **shared UI components** through `@pond/sdk/ui` (re-exports of `components/common`), the Vuetify theme, and the SDK's API client. They bring no CSS framework and no global CSS, and cannot remove or replace core items.

### The SDK (`packages/sdk`, MIT)
- Exports `definePad`, `definePadClient`, the `PadContext` and request types, the manifest schema, `z` (zod, re-exported so versions can't drift) and the UI re-exports.
- **`@pond/sdk/testing`** ships an in-memory host: fake core data, fake table store, a clock, and an event emitter. **A pad's tests run entirely on fakes, without Pond core**, the same philosophy as our own tests. We use it for both official pads.

### Ready for isolation later
Every `ctx` call takes and returns plain JSON-serializable data, is async, and passes no live objects or callbacks (handlers are registered once at `register`). A test mode runs every facade call through a JSON round trip, so a change that would break a future remote transport fails a test today.

## Pads that aren't about money

A pad doesn't have to touch finances at all. The first example is a **CRM** (contacts, companies, notes, follow-ups), requested by the primary user. The design supports that with no special cases:

- **Zero core permissions is a normal pad.** It needs only its own tables, so it asks for no `transactions:read`, `accounts:read` and so on. The install screen should say so plainly ("This pad can't see your accounts or transactions"), which is a good thing for people to read.
- **The table API carries it.** Records, search (`contains`, `startsWith`, `or`), ordering and paging cover contact lists, notes and follow-up dates. Linked records (a note belongs to a contact) are plain id lookups.
- **Space scoping still applies.** A CRM belongs to a Space (for example the WibbitWorks business Space), and `spaceTypes` can list both `business` and `personal`.
- **The shared UI must not assume money.** The SDK's UI exports should lean on generic components (tables, form fields, dialogs, search selects) and keep the money components separate, so a non-financial pad doesn't carry financial UI.
- **Sensitive fields** (for example a client's personal details) can use `ctx.secrets` field encryption, like the Business pad's SSNs.
- **Attachments** use `ctx.files`, built in M6; the CRM would be one of its users.
- A CRM that wants to link clients to payments can request `transactions:read` like any pad; nothing special is needed.

## What core needs (new pieces)

- Tables: `lilypad_installs`, `lilypad_space_enablement`, `lilypad_migrations` (already in `data-model.md`) and `lilypad_job_runs`; migration with fixture.
- Repositories (with fakes and contract tests): `PadInstallRepo`, `PadMigrationRepo`, `PadJobRunRepo`, `SettingsRepo` (the `settings` table exists, no repo yet), `PadTableRepo`, and `SplitSumRepo` (the `splits.sum` aggregate).
- `EventBus` and emit calls in the ledger, sync and import services.
- `PadHost` (registry, state machine, migrations, gating), `PadContext` factory, facade, scheduler.
- Routes: admin install/uninstall, per-Space enable, `GET /api/spaces/:id/lilypads`; web: Settings > LilyPads and the Space switch.

## Proposed build order

1. **M5a, the host and SDK:** the new core pieces above, a tiny **fixture pad** used only in tests (proves permissions, Space gating, table-API limits, migrations, failure isolation, events and jobs), SDK skeleton with `@pond/sdk/testing`, admin and Space UI.
2. **M5b, Personal Finance pad** (`personal-finance-pad.md`): budgets, goals, widgets, transaction panel, built only on the public SDK. If it needs something the SDK lacks, that is a design bug to fix in the SDK.

Splitting M5 into two PRs keeps each reviewable.

## Changes to `lilypad-contract.md` if you approve

1. Pad routes are Space-scoped (`/api/spaces/:spaceId/lilypads/<id>/...`), declared with a required `role` and zod schemas.
2. `ctx.core` becomes a per-request/job **scoped `core`** (no `spaceId` argument), and `ctx.db(table)` becomes `db.table(name)` with the table API above and declarative migrations (the manifest's `migrations/` holds migration modules, not SQL).
3. `ctx.jobs.schedule` takes a structured schedule instead of cron.
4. Settings UI is generated from `settings.schema.json`.
5. Write APIs in `ctx.core` are specified but arrive when a pad needs them.
6. Add `splits.sum` to the core API list; add the JSON-serializable rule.

## What I need from you

1. **Registry vs runtime loading (decision 1):** OK to use a build-time registry for the official pads in v1?
2. **Space-scoped routes (decision 2):** OK to change the contract's route path so pad routes are tested for free?
3. **Table API instead of a raw query builder (decision 4):** this is the biggest departure from the contract; it trades some pad-author flexibility for safety and testability. Comfortable with that?
4. **Install flow:** is "admin installs, then Space owners flip a switch" right for official pads that ship in the image, or should official pads come pre-installed to save the admin a step? (It is simpler for users if they do, but the contract wants the admin to see permissions.)
5. Anything in the table above you'd rather decide differently.
