# LilyPad contract

A **LilyPad** is a plugin that adds pages, tables, reports and behavior on top of Pond Core. Everything a LilyPad can do goes through a context object (`ctx`) supplied by the core. The SDK lives in `packages/sdk` (MIT).

## v1 boundaries

- **Official LilyPads only**, built by WibbitWorks and shipped inside the Pond image (`lilypads/`). They load in-process.
- No community LilyPads, no isolation runtime, no submission process, no LilyPad-to-LilyPad dependencies. These come later.
- The API must still be designed so `ctx` can later be backed by a remote transport (an isolated process or container) **without changing LilyPad code**. That rules out handing LilyPads raw database handles to core tables, Express `req`/`res` internals beyond what the SDK wraps, or Node globals the core depends on.

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
  "permissions": ["transactions:read", "transactions:write", "accounts:read", "secrets:use", "files:store"],
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

`sync.completed`, `account.added`, `transaction.created`, `transaction.updated`, `split.changed`, `space.created`, `backup.before`.

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

The client entry exports Vue components registered against these points. Use the shared theme tokens; no global CSS.

## Lifecycle

1. **Install** (admin only): the admin reviews the manifest and approves permissions.
2. **Migrate:** Pond takes a backup, then runs the pad's migrations, which are recorded in `lilypad_migrations`.
3. **Enable:** Space owners turn the pad on for their Space (only allowed Space types are offered).
4. **Update:** the same backup-then-migrate path. New permissions require re-approval.
5. **Disable:** hidden per Space or globally; data is kept.
6. **Uninstall:** the admin chooses to keep the pad's data (`lp_<id>_*` tables and files) or delete it.

Pad tables and pad versions are included in backups.

## Official LilyPads in v1

- **Personal Finance:** simple monthly budgets by category, savings goals, and dashboard widgets for personal Spaces. Full scope in `personal-finance-pad.md`. Bills are planned as a separate LilyPad later (`future.md`).
- **Business Manager:** business profile, Schedule C reports, people and salary records, and documents, ported from business_manager.
