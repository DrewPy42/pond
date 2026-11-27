# LilyPad contract

A **LilyPad** is a plugin that adds pages, tables, reports and behavior on top of Pond Core. Everything a LilyPad can do goes through a context object (`ctx`) supplied by the core. The SDK lives in `packages/sdk` (MIT).

## v1 boundaries

- **Official LilyPads only**, built by WibbitWorks and shipped inside the Pond image (`lilypads/`). They load in-process.
- No community LilyPads, no isolation runtime, no submission process, no LilyPad-to-LilyPad dependencies. These come later.
- The API must still be designed so `ctx` can later be backed by a remote transport (an isolated process or container) **without changing LilyPad code**. That rules out handing LilyPads raw database handles to core tables, Express `req`/`res` internals beyond what the SDK wraps, or Node globals the core depends on.

## Amendments (2026-11-22)

The original contract was written before any code existed. These changes were agreed while designing the host (`lilypad-host-design.md`) and **win over the text below wherever they conflict**. M5a implemented them (see "As built (M5a)" below); where the code differs from the body, the code and that section are right. Each says why, and none weakens security.

| # | Change | Why |
|---|---|---|
| A1 | **Pad routes are Space-scoped**: `/api/spaces/:spaceId/lilypads/<id>/...`, declared through the same `createSpaceRouter` as core routes, each with a required minimum role and zod schemas. Replaces `/api/lilypads/<id>/...`. | Reuses the one auth and Space middleware (CLAUDE.md rule 5). Pad routes get 401, 404-for-non-members and role checks automatically, and the permission suite tests every pad route with no extra code. A pad also has to be enabled for the Space or the route is a 404. Strictly stronger than the original; pads never build URLs themselves (the SDK client does), so no pad code depends on the path. |
| A2 | **`core` is scoped, not global**: each route handler and job receives a `core` object bound to one Space and one acting user. Its methods take no `spaceId`. Replaces the global `ctx.core`. | A pad cannot ask about a Space it wasn't called for. Permission checks live in one place. Calls stay plain JSON, so an isolated pad can use the same API later. |
| A3 | **Structured schedules** (`daily`, `weekly`, `monthly` with a time) instead of cron strings, with catch-up after downtime and a per-Space run record. | No cron parser dependency; clearer for pad authors; a Pi that was off on the 1st still runs the monthly job. |
| A4 | **Pad settings screens are generated** from `settings.schema.json`. | Pad authors write no settings UI; every pad's settings look and behave the same (simple by default). |
| A5 | **Core write APIs are deferred**: `transactions:write`, `splits.set`, `categories:write` stay specified but are built when a pad needs them. v1 pads are read-only toward core. | Smaller surface to secure; neither v1 pad writes core data. Adding an operation later is non-breaking. |
| A6 | **`splits.sum({ from, to, groupBy, kind })`** is added to the core API: integer-cent totals from splits, excluding transfers and removed transactions. **Every `ctx` call must take and return plain JSON data** (enforced by a test that round-trips each call). | One way to total money (also used by core Reports); keeps the door open to running pads in isolation. |
| A7 | **Loading and install:** official pads are discovered from a build-time registry behind a `PadSource` interface (the contract's runtime `entry` loading arrives with third-party pads). Pads may be **optional**: shipped in the image but off until an **admin installs** them (reviewing permissions), after which **Space owners enable** them per Space. An update can ship new pads; they appear as available, never auto-enabled. | Simplest packaging for v1 while keeping the swap to runtime loading contained to one interface. Admin approval of permissions is preserved. |
| A8 | **Pad data uses a table API, not a query builder**: `find`, `findOne`, `insert`, `insertMany`, `update`, `delete`, `count`, with simple filters, text search and `or` groups, declarative migrations, and automatic Space scoping. No raw SQL. Replaces `ctx.db(table)` as a query builder. | A pad can't name a core table or another Space's rows, queries are parameterized by construction, it is easy to fake for tests, and it is plain JSON so pads can be isolated later. Easy to extend (add operations), hard to take back (removing raw SQL), so we start small. Also enough for pads that never touch finances, such as a CRM. |

## As built (M5a)

- **Management routes.** Admin: `GET /api/lilypads`, `POST /api/lilypads/:padId/install` (body must list exactly the permissions shown), `POST .../uninstall`, `GET|PUT /api/lilypads/:padId/settings` (global settings). Space owners: `GET /api/spaces/:spaceId/pads`, `GET .../pads/available`, `PUT .../pads/:padId/enabled`, `GET|PUT .../pads/:padId/settings`. Pad routes themselves are `/api/spaces/:spaceId/lilypads/<id>/...`, and the segment `_host` is reserved.
- **Settings** are declared inline in the manifest (not a separate `settings.schema.json`) and stored as `lp.<id>.<key>`.
- **Pad data** uses the table API (A8). Tables are `lp_<padId>_<table>`; every table gets `id`, `created_at`, `updated_at` (plus `space_id` for Space-scoped tables) automatically.
- **Failure isolation.** Repeated handler/job/event failures disable the pad (routes return 503) and write `lilypad.auto_disabled` to the audit log. In tests the JSON boundary guard is always on.
- **Dev-only pads.** `lilypads/template` is a working example (notes). It is only loaded when `POND_DEV_PADS=true` and `NODE_ENV` is not production; its web code ships in the bundle but does nothing otherwise.
- **Not built yet:** admin UI for global settings (route exists), account-detail panel and report-page extension points (arrive with M7), core write APIs (A5).
- **Licensing note:** `@pond/sdk` is MIT but imports types from `@pond/shared`, which is part of the AGPL core. Decide before publishing the SDK whether to make those types SDK-owned.

## As built (M6a): files and password re-check

Plugin API **1.1.0** (additive; `^1.0` pads still load).

**Upload routes.** `upload: { maxBytes, types }` on a `post` route (`put` is also allowed, though the web SDK's `api.upload` sends POST). The pad needs `files:store`, can't also declare `body`, and `maxBytes` is at most 25 MB; types are `pdf`, `jpeg`, `png`. The request body is the file (`application/octet-stream`, uncompressed); details go in the query string. Order of checks: sign-in, CSRF, Space role, pad enabled, password re-check if declared, and only then is the body read. The type comes from the file's first bytes. The handler gets `req.file = { id, size, type }`, never the bytes. If the handler throws, or the query is invalid, no file is kept. A handler that succeeds without saving `req.file.id` leaves a file nothing refers to, so always save it.

**Files.** `req.files.download(fileId, filename)` (return it from the route) and `req.files.remove(fileId)`. A file is reachable only from the Space that stored it. Downloads are always attachments, with `nosniff` and `no-store`; the filename is cleaned and given an ending that matches the real type. On disk: `/data/files/<padId>/<spaceId>/<fileId>`, AES-256-GCM with the master key, with the three IDs authenticated.

**Password re-check.** `reauth: true` on a route answers `403 reauth_required` unless the password was entered in the last 5 minutes. Pond's web app shows the password box and retries once; the pad never receives the password. The host audits every successful call (`lilypad.reauth_access`, with the route pattern, never values or parameters; a pad that needs to record *whose* record was opened uses `req.audit`). Responses are `no-store`. It adds to the role check and never replaces it.

**Web.** `usePadHost().api.upload(path, file, query)` and `.download(path, query)`. A sidebar item or page can set `role: 'owner'` to hide it; this is tidiness, and the server route is what enforces access.

**Testing.** `createTestPad` keeps files in memory per Space: `call(..., { file, reauthed })`, `result.download`, and `files()`.

## As built (M6b)

Plugin API **1.2.0** (additive).

- **Transactions a pad reads** carry `linkedTransfer: boolean`, true for either side of a linked transfer, so a pad can label them (`splits.sum` already leaves them out).
- **`usePadHost().isOwner`** lets a pad show owner-only controls. It is for display; the server route's role is what enforces access.
- **Unique indexes on a per-Space table are unique within a Space.** Before this, they applied across all Spaces, which broke pads used in two Spaces and let a "duplicate" error hint at another Space's data. Both stores and the shared contract now include the Space. (Indexes already created on an existing database keep their old form; the only shipped one, in Personal Finance, includes a category ID that differs between Spaces, so it behaves the same.)

## As built (M7)

Plugin API **1.3.0** (additive).

- **`splits.sum` rows carry `inCents`**, the positive splits alone, so money in and money out can be told apart (out = `cents - inCents`).
- **`splits.sum` totals only accounts in the Space's own currency.** Before this it added different currencies together.
- **Report links.** A pad lists reports with `reportPages: [{ title, description, path, role? }]` in `definePadClient`. Pond shows them under core Reports, labeled with the pad's name, linking to the pad's page.
- **Still not built:** the account-detail panel. Pond has no account detail page yet (`future.md`).

## Manifest (`lilypad.json`)

```json
{
  "id": "business",
  "name": "Business Manager",
  "version": "1.0.0",
  "author": "WibbitWorks",
  "license": "AGPL-3.0",
  "pondApi": "^1.0",
  "spaceTypes": ["business"],
  "permissions": ["transactions:read", "secrets:use", "files:store"],
  "entry": { "server": "dist/server.js", "client": "dist/client.js", "migrations": "migrations/" },
  "settings": "settings.schema.json"
}
```

- `id`: lowercase, `[a-z0-9-]`; used in table prefixes and URLs.
- `pondApi`: the semver range of the core plugin API this pad supports. Pond refuses to enable a pad outside its range.
- The trust tier is **not** declared here. It comes from where the pad was loaded (v1) or its signature (later).

## Server side

```ts
import { definePad } from '@pond/sdk';

export default definePad({
  async register(ctx) {
    ctx.router.get('/payroll', async (req) => {
      return ctx.db('lp_business_people').where({ space_id: req.space.id });
    });
    ctx.events.on('transaction.created', async (e) => { /* ... */ });
    ctx.jobs.schedule('monthly-summary', '0 6 1 * *', async () => { /* ... */ });
  },
});
```

`ctx` provides:

| Member | Purpose |
|---|---|
| `ctx.router` | Routes mounted at `/api/lilypads/<id>/…`. Auth, Space resolution and zod validation are applied by the core. `req.space`, `req.user` are provided. |
| `ctx.db(table)` | Query builder limited to `lp_<id>_*` tables. Any other table name throws. |
| `ctx.core` | Permission-checked core API: `transactions.list/get/update`, `splits.set`, `accounts.list`, `balances.history`, `categories.list/create`, `spaces.get`. |
| `ctx.events` | Subscribe to core events (below). |
| `ctx.jobs` | Scheduled jobs, run by the core scheduler. |
| `ctx.settings` | Read/write this pad's settings (global and per Space). |
| `ctx.secrets` | `encrypt`/`decrypt` via the core master key (needs `secrets:use`). |
| `ctx.files` | Store/read files under `/data/files/<padId>/` (needs `files:store`). |
| `ctx.audit` | Write audit entries attributed to the pad. |
| `ctx.log` | Logger scoped to the pad. |

Every `ctx.core` call is checked against the permissions the admin granted, plus the acting user's Space access. A pad can never see more than the user it acts for, except in scheduled jobs, which run per enabled Space with that Space's scope.

## Permissions

`transactions:read`, `transactions:write`, `accounts:read`, `balances:read`, `categories:write`, `spaces:read`, `secrets:use`, `files:store`, `network:<host>` (later), `ai:use` (later).

The admin sees and approves the list at install. A pad update that requests new permissions stays disabled until re-approved.

## Events (v1)

`sync.completed`, `account.added`, `transaction.created`, `transaction.updated`, `split.changed`, `space.created`.

Payloads carry IDs and minimal fields. Pads fetch details through `ctx.core`, so permission checks apply.

## UI extension points

The core shell owns the sidebar, Space switcher, settings and dashboard. LilyPads can add to it, but never remove or replace core items.

| Extension point | Notes |
|---|---|
| Sidebar section | The pad's own pages, shown only in Spaces where it's enabled |
| Reports | Pad reports are listed inside the pad **and** under core Reports, labeled with the pad name |
| Dashboard widgets | Space-scoped cards |
| Account detail panel | Extra panel on an account page |
| Transaction detail panel | Extra panel on a transaction |
| Space settings tab | The pad's per-Space settings |

A pad imports the web side (`definePadClient`, `usePadHost` and their types) from `@pond/sdk/client`, and everything else from `@pond/sdk`. **Code the server loads must not import `@pond/sdk/client`:** the production server has no browser packages such as Vue.

The client entry exports Vue components registered against these points. Use the shared theme tokens; no global CSS.

## Lifecycle

1. **Install** (admin only): the admin reviews the manifest and approves permissions.
2. **Migrate:** Pond takes a safety copy of the database (and doesn't go ahead if it can't), then runs the pad's migrations, which are recorded in `lilypad_migrations`.
3. **Enable:** Space owners turn the pad on for their Space (only allowed Space types are offered).
4. **Update:** the same backup-then-migrate path. New permissions require re-approval.
5. **Disable:** hidden per Space or globally; data is kept.
6. **Uninstall:** the admin chooses to keep the pad's data (`lp_<id>_*` tables and files) or delete it.

Pad tables, files and applied migrations are included in backups. Pond copies them itself, so a pad does nothing. A column holding a value encrypted with `ctx.secrets` **must** have a name ending in `_enc`: backup and restore use that to check the key opens it.

## Official LilyPads in v1

- **Personal Finance:** simple monthly budgets by category, savings goals, and dashboard widgets for personal Spaces. Full scope in `personal-finance-pad.md`. Bills are planned as a separate LilyPad later (`future.md`).
- **Business Manager:** business profile, Schedule C reports, people and salary records, and documents, ported from business_manager.
