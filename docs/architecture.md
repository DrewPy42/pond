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
        Backup destinations: download, mounted folder/USB, rclone remote
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
- Data lives on one volume, `/data`:
  - `pond.db` (SQLite)
  - `keys/master.key`
  - `files/` (uploads, such as Business documents)
  - `backups/` (local staging)
- **v1 is home-network only.** No port forwarding. Remote access (Tailscale) comes later.
- **Updates in v1:** Pond checks the release feed and shows "update available." The user runs the documented command (`docker compose pull && docker compose up -d`). Pond takes a backup automatically on startup before running new migrations. One-click updates come later.

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
