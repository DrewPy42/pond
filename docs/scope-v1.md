# Version 1 scope

**Version 1 runs our household and WibbitWorks.** Anything complicated stays out of v1.

## In v1

- SimpleFIN sync + manual accounts
- Ledger: transactions, splits, categories, transfer links, balance history
- Spaces, multiple users, roles and permissions; per-transaction privacy for cross-Space splits
- Rules-based auto-categorizing
- CSV statement import with a review step
- LilyPad API, official LilyPads only
- Personal Finance and Business Manager LilyPads
- Core reports + LilyPad reports
- Encrypted backups: download, mounted folder (NAS/USB), rclone remote
- Restore that overwrites everything
- Security baseline (`security.md`): passwords + TOTP, encrypted secrets, audit log
- Home network only; Docker on a Raspberry Pi; SQLite
- "Update available" notice + one documented update command
- gloxV brand theme and logo

## Later (do not build in v1)

- AI Assistant: per-account auto-categorizing, savings and growth insights (user's own API key)
- Bills LilyPad: recurring-charge detection, upcoming bills, subscriptions (notes in `future.md`)
- Reimbursables tracking (the data fields exist; no screens in v1)
- Investments LilyPad (holdings); brokerage balances still sync and count toward net worth in v1
- PDF statement import
- Passkeys (need HTTPS on a real hostname)
- Community verified and unverified LilyPads, isolation runtime, signing, submission process
- LilyPad dependencies on other LilyPads
- Built-in Google Drive, Dropbox, Box backup buttons
- Restore that merges without loss or duplicates
- Remote access via Tailscale
- One-click updates with automatic rollback
- Prebuilt Pi image with full-disk encryption

## Reference hardware

Raspberry Pi 4 (4 GB) or newer, 64-bit OS, SSD over USB strongly recommended over an SD card. Everything must also run on amd64 for development.

## Milestones

Each milestone ends with working, tested software.

| # | Milestone | Done when |
|---|---|---|
| M0 | Scaffold | Monorepo, lint/test/CI, Docker dev setup, Vue shell with gloxV theme, crypto module, migrations running |
| M1 | Identity | First-run setup code, users, password + TOTP, sessions, Spaces, members, roles, permission middleware with tests, audit log |
| M2 | Ledger | Manual accounts, transactions, splits (invariant enforced), categories with seeds, transfer links, balance snapshots, transactions UI |
| M3 | SimpleFIN | Connect via Setup Token, account discovery and Space assignment, scheduled sync, pending reconciliation |
| M4 | Rules & import | Rules engine and UI; CSV import with column mapping, duplicate detection, review |
| M5 | LilyPad host | SDK, manifest loading, `ctx`, permissions, events, UI extension points; Personal Finance pad |
| M6 | Business pad | Port business_manager: profile, Schedule C reports, people and salary (SSN masked + reveal), documents |
| M7 | Reports | Cash flow, spending by category, net worth over time, LilyPad reports listed in core Reports |
| M8 | Backups | Backup format, schedule, destinations, retention, full-overwrite restore |
| M9 | Ship | Production Docker images (arm64 + amd64), Caddy config, install docs, update-available notice |

## Open items to settle during the build

- The gloxV theme tokens and logo need to be pulled from `~/Sites/gloxV` (M0).
- ~~What exactly the Personal Finance pad includes~~ Settled 2026-11-22: monthly category budgets, savings goals, dashboard widgets. See `personal-finance-pad.md`. Bills are a v2 LilyPad and reimbursables are v2 (`future.md`).
- SimpleFIN's current request limits and history depth, checked against a real account (M3). The protocol page documents no limits; Pond is conservative (a 90-day first pull, 12-hour default interval, manual sync at most every 5 minutes) until this is confirmed with a real account.
