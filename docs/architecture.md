# Architecture

## Goal

One household runs one Pond install on its own hardware. Pond pulls read-only bank data through the user's own SimpleFIN Bridge account and keeps everything locally. Personal and business finances live side by side, separated by **Spaces**. Features beyond the core ledger come from **LilyPads**.

## Components

```
                ┌──────────────── Raspberry Pi (Docker) ────────────────┐
 Browser ──HTTPS──► Caddy ──► Pond server (Express, single Node process) │
                │              ├─ Auth & sessions                       │
                │              ├─ Permission middleware (Space + role)  │
                │              ├─ Ledger API (accounts, txns, splits…)  │
                │              ├─ SimpleFIN sync (scheduled)            │
                │              ├─ Rules engine                          │
                │              ├─ CSV import                            │
                │              ├─ Event bus                             │
                │              ├─ LilyPad host (official pads, in-process)
                │              ├─ Backup & restore                      │
                │              └─ Audit log                             │
                │            SQLite file (WAL) + /data volume           │
                └────────────────────────────────────────────────────────┘
        SimpleFIN Bridge (cloud, user's account) ◄── daily pull
        Backup destinations: download, mounted folder/USB
```

### Pond Core
- **Ledger:** accounts, transactions, splits, categories, transfer links, balance history. This is the heart; everything else reads from it.
- **SimpleFIN sync:** turns a user's Setup Token into an Access URL (stored encrypted), then pulls accounts and transactions on a schedule.
- **Spaces & permissions:** a Space is a separate set of finances, either personal or business. Users are members of Spaces with roles.
- **Rules engine:** user-defined rules that set payee, category or Space on new transactions. Runs before anything else categorizes.
- **CSV import:** brings in history SimpleFIN doesn't have, plus transactions for manual accounts.
- **Event bus:** in-process pub/sub. Core emits events, and LilyPads subscribe through `ctx.events`.
- **LilyPad host:** loads, migrates and mounts LilyPads. See `lilypad-contract.md`.
- **Backup & restore:** see `backup-restore.md`.
- **Settings & secrets:** global, per-Space and per-user settings. Secrets go through the crypto module.
- **Theme & shell:** the Vue app frame, with the sidebar, Space switcher and the core pages.

### Runtime
- One Docker image with the Node server and built web assets, plus a Caddy container for TLS.
- The image is built by `deploy/Dockerfile`. When `POND_WEB_DIR` is set, as it is there, the server also serves the built web app: page addresses get `index.html`, a missing file is a 404, `/api` is never answered with a page, and only the hashed files under `assets/` are cached long-term. In development Vite serves the web app instead.
- `deploy/compose.yml` runs Pond and Caddy. Only Caddy publishes ports. Settings come from `deploy/.env` (see `.env.example`): the address, time zone, backup folder, ports and HSTS.
- It runs as user 1000 and needs to write only to `/data`, `/backups` and `/tmp`, so the rest of its filesystem can be read-only.
- Data lives on one volume, `/data`:
  - `pond.db` (SQLite)
  - `keys/master.key`
  - `files/` (uploads, such as Business documents)
  - `backups/` (automatic safety copies; they never leave this volume)
  - `restore/` and `tmp/` (only while a restore or backup is under way)
- A second mount, `/backups`, is the only folder on this computer backups are written to.
- **v1 is home-network only.** No port forwarding. Remote access (Tailscale) comes later.
- **Updates in v1:** Pond checks the release feed and shows "update available." The user runs the documented command (`docker compose pull && docker compose up -d`). Pond takes a safety copy automatically on startup before running new migrations. One-click updates come later.

## Request lifecycle

1. Caddy terminates TLS and forwards to Express.
2. Session middleware loads the user, or returns 401.
3. Space resolution: the route's `:spaceId` (or the active Space header) is checked against `space_members`. Admins pass all checks.
4. Role check for the action (viewer can read; editor can change data; owner can also manage members, settings and LilyPad enablement).
5. Zod validates the input; the handler runs in a transaction where it writes.
6. Writes emit events and audit entries where the action is sensitive.

## SimpleFIN sync flow

1. **Connect:** the user pastes a Setup Token into Settings. The server base64-decodes it to a claim URL, POSTs once to receive the Access URL, and encrypts and stores it in `connections`. The Setup Token is single-use and is never stored.
2. **Discover:** `GET /accounts?balances-only=1` lists the accounts behind the token. The admin assigns each account a primary Space (or leaves it unassigned and hidden).
3. **Scheduled pull:** a few times a day at most, fetch `/accounts?start-date=<last sync − 14 days>&pending=1`. Re-read the current SimpleFIN limits before choosing the schedule; Bridge data generally refreshes about daily, so polling more often gains nothing.
4. **Upsert:** accounts by `(connection_id, external_id)`, transactions by `(account_id, external_id)`. New transactions get one split (the account's primary Space, uncategorized), then the rules engine runs.
5. **Pending reconciliation:**
   - A pending transaction that no longer appears in the overlap window is marked `status = removed`, unless the user edited it; edited ones stay and get flagged for review.
   - When a posted transaction looks like a removed pending one (same account, same amount, date within 5 days, similar description), carry over the pending transaction's splits and categories.
6. **Balances:** write today's `balance_snapshots` row per account.
7. **Finish:** emit `sync.completed`, update `connections.last_synced_at`, and record errors on the connection for the UI to show.

One connection can feed many users. Accounts belong to Spaces, not to the token, so a child's account can sit in the child's Space while the parent's accounts stay invisible to them.

## Modular UI and shared code

Pond will have many screens (ledger, imports, reports, Settings, every LilyPad). To keep them consistent and small, **build from shared pieces and don't repeat markup or logic.** The same applies on the server.

### Layers (web)

1. **Vuetify 3 primitives.** The only component library (`CLAUDE.md`). Pages never reach for raw HTML controls where a Vuetify one exists.
2. **Pond common components** in `apps/web/src/components/common/`, exported from one barrel (`index.ts`). These are thin, opinionated wrappers: the one input, table, dialog and card that the whole app uses. Brand, spacing, WCAG contrast, keyboard behavior and `aria` labels are fixed here once.
3. **Composables** in `apps/web/src/composables/` for shared behavior (API calls and error mapping, pagination, form state and zod validation, debounced search, confirm-before-delete).
4. **Pinia stores** for shared state (auth, Spaces, and later accounts and categories).
5. **Feature views** in `apps/web/src/views/` that only compose the layers above.

### Starter set

`~/Sites/gloxV/client/src/components/common` is a good reference for *what* to share (its styling and Bootstrap/Font Awesome usage are **not** carried over). Expected components:

| Component | Purpose |
|---|---|
| `FormField` | Label, input, hint and error in one; text, number, money, date, select, textarea |
| `MoneyInput` / `MoneyAmount` | Enter and display `amount_cents`; sign plus icon plus contrast-safe color, never color alone |
| `DataTable` | Sorting, paging, search, row actions, empty and loading states |
| `Pagination`, `SearchSelect` | Shared by tables and pickers |
| `Modal` / `ConfirmDialog` | One dialog pattern, focus trapped, Escape to close |
| `Card`, `StatCard` | Page sections and dashboard figures |
| `Toast` | One place for success and error messages |
| `QrCode` | Already in use (TOTP enrollment) |

Add a component to the barrel the **second** time something is needed, not the first guess. When you write the same markup or logic twice, extract it before writing it a third time.

### Rules

- **Props, slots and `v-model`, not copies.** Variation comes from props and slots; don't fork a component per page.
- **Accessibility lives in the component.** A page can't ship an unlabeled input or low-contrast money color if it uses the shared one.
- **Tested once.** Common components carry their own tests; pages then need fewer.
- **LilyPads reuse them.** `packages/sdk` re-exports the common components and composables through its UI helpers, so a LilyPad looks and behaves like core without bundling its own copies (see `lilypad-contract.md`).
- **No `v-html` with user data**, in any shared component.

### Same idea on the server and in `packages/shared`

- Request and response **zod schemas, types and money helpers** live in `packages/shared`, used by both server and web, never redefined per side.
- **Data access goes through repositories** (`apps/server/src/repos`): routes, middleware and services depend on interfaces (`UserRepo`, `SessionRepo`, `SpaceRepo`, `AuditRepo`, ...) passed in via `AppContext`. Only the Drizzle implementations touch the database, which keeps business logic testable on in-memory fakes (`testing.md`). New tables get a repository, a fake, and a contract test.
- Cross-cutting server behavior is a helper, not copy-paste: `createSpaceRouter` and `requireSpace` for Space access, `validateBody` for input, `recordAudit` for the audit log. New routes use them.

## Ledger (M2)

All ledger routes are Space-scoped (`/api/spaces/:spaceId/...`) and declared through `createSpaceRouter`, so the permission suite covers each one automatically.

| Area | Routes |
|---|---|
| Accounts | `GET/POST /accounts`, `GET/PATCH /accounts/:accountId`, `GET /accounts/:accountId/balances`, `PUT /accounts/:accountId/balances/:date` |
| Categories | `GET/POST /categories`, `PATCH /categories/:categoryId` |
| Transactions | `GET/POST /transactions`, `GET/PATCH/DELETE /transactions/:transactionId` |
| Transfers | `POST /transfers`, `DELETE /transfers/:transactionId` |

- **Where the rules live:** `apps/server/src/ledger/`: `splits.ts`, `visibility.ts`, `transfers.ts` and `categorySeeds.ts` are pure functions; `service.ts` applies them through the repositories; `routes/ledger.ts` only validates and responds.
- **The split invariant** (every active transaction has at least one split and its splits sum exactly to its amount) is enforced inside `TransactionRepo.create/update`, so no write path can skip it. `findInvariantViolations()` exists to prove it holds.
- **Cross-Space privacy:** a Space's transaction list includes transactions on other Spaces' accounts that have a split in it, shown through `viewTransaction` (see `data-model.md`). To put a split in another Space you must be able to edit that Space.
- **Transfers:** two transactions with equal and opposite amounts on different accounts of the same currency; you must be able to edit both accounts.
- **Starter categories** are seeded when a Space is created, and at startup for any Space that has never had categories.
- **Response and request shapes** are shared in `packages/shared` (`ledger.ts` zod schemas, `ledgerViews.ts` types).

## SimpleFIN sync (M3)

Implemented in `apps/server/src/simplefin/` (protocol client) and `apps/server/src/sync/` (rules and scheduling).

- **One door to the network:** `SimpleFinClient` (`claim`, `fetchAccounts`). The real one uses Node's built-in `fetch`; tests use a scripted fake, so no test touches the network.
- **Connect (admin only, `/api/connections`):** the Setup Token is decoded, claimed once, and the Access URL is stored encrypted before anything else can fail (the token is single-use). The token is never stored. Discovery then lists the bank's accounts as hidden, unassigned local accounts; an admin gives each a Space, which turns syncing on.
- **Pull:** `syncConnection` asks for pending transactions since 14 days before the last successful sync (90 days the first time). Manual "Sync now" is limited to once per 5 minutes. A scheduler in the server process runs every 12 hours by default (`POND_SYNC_INTERVAL_HOURS`, clamped 4 to 24), with jitter, never overlapping, and logs counts only.
- **Rules** are pure and live in `sync/plan.ts` (`planSync`): new, unchanged and changed transactions by `(account, external_id)`; amount changes follow a lone split but flag multi-split transactions for review; user-edited rows are never overwritten.
- **Pending reconciliation:** a pending transaction the bank stops listing (inside the fetch window) is marked removed unless a person edited it, in which case it stays and is flagged. A new posted transaction with the same amount, within 5 days and with similar text, inherits the pending one's splits, categories, payee and memo; the pending one is marked `superseded_by` the new one so it can't be matched twice.
- **Safety:** all URLs must be public `https` on port 443 (no localhost or private ranges, no redirects) because an admin pastes them. Server messages are stripped of control characters and length-limited before they are stored or shown. Amounts are decimal strings converted to cents without floats; a real fraction of a cent skips that account instead of rounding. An account with unreadable data is skipped whole and the sync window is not advanced past it.
- **Bank-fed accounts** can't have transactions typed in by hand; their balance snapshots come from sync (`source = sync`).

## Rules and CSV import (M4)

**Rules** (`apps/server/src/rules/`): `engine.ts` is pure (match conditions, decide the outcome); `service.ts` applies it through repositories.
- A rule is a set of conditions that must **all** match (text on description or payee, amount range, account, direction) and a list of actions (set payee, set category, move to Space, mark reimbursable, link as transfer).
- Text tests are `contains`, `starts_with`, `equals` and `matches`. **`matches` is a wildcard pattern (`*`, `?`), not a regular expression**: user-written regexes can freeze a server, and the wildcard matcher cannot be made to run for exponential time.
- Rules run in priority order (lowest number first). Every matching rule applies, but each kind of change is made by the **first** rule that asks for it, so a higher-priority rule is never overridden.
- Rules run on **new** transactions (bank sync, CSV import) and on demand through "Run on uncategorized" (existing, uncategorized transactions). They **never** touch a transaction a person edited, a removed one, or the splits of a multi-split transaction.
- "Move to Space" and "link as transfer" run under the permissions of the person who last saved the rule; if they can no longer edit the target Space, those actions are skipped. Categories must belong to the Space the money ends up in. Linking needs exactly one matching opposite transaction (same amount, other account, same currency, within 5 days); ambiguous or missing matches are left for a person.

**CSV import** (`apps/server/src/imports/`): two stateless steps. `POST .../imports/preview` parses the uploaded text with the user's column mapping (delimiter, header, date format, one signed amount column or separate debit and credit columns) and returns every row flagged **new**, **duplicate** or **invalid**, saving nothing. `POST .../imports` re-parses the same file and creates the rows the user kept, in one batch, then runs the Space's rules. Duplicates are matched by account, date, amount and normalized description, **by count**, so two genuine identical purchases on one day aren't both called duplicates. Imports work on bank-fed accounts too (history the bank doesn't send). The upload limit (6 MB, 20,000 rows) is raised for the import routes only.
