# Core data model

## Conventions

- **IDs:** every primary key is an app-generated UUIDv7, stored as `TEXT`. A stable ID is what makes future merge-restore possible: the same ID means the same record.
- **Money:** `*_cents` columns are `INTEGER`. Signed; positive = money into the account (same as SimpleFIN). A credit card purchase is negative, and a credit card balance is negative when money is owed.
- **Currency:** stored on the account (ISO code, default `USD`). v1 assumes one currency per Space and doesn't convert.
- **Time:** instants are UTC ISO strings (`*_at`); calendar days are `YYYY-MM-DD` in the household's time zone (`date`).
- **Soft delete:** user-facing records use `archived_at` or `status`, not hard deletes, so history and restores stay consistent.
- **Timestamps:** every table has `created_at`; mutable tables also have `updated_at`.

## Tables

### Identity and access

**users**: `id`, `username` (unique), `display_name`, `email?`, `password_hash` (Argon2id), `totp_secret_enc?`, `is_admin`, `status` (active | disabled), `last_login_at`

**sessions**: `id` (hash of the session token), `user_id`, `expires_at`, `last_seen_at`, `reauth_at?` (time of the last password re-entry, for reveals), `ip`, `user_agent`

**spaces**: `id`, `name`, `type` (personal | business), `currency`, `archived_at?`

**space_members**: `space_id`, `user_id`, `role` (owner | editor | viewer). Primary key is (`space_id`, `user_id`). Admins don't need rows; they see everything.

### Money

**connections**: `id`, `label`, `access_url_enc`, `created_by`, `status` (active | error | revoked), `last_synced_at?`, `last_error?`

**accounts**: `id`, `connection_id?` (null for manual), `external_id?` (SimpleFIN account id), `institution_name?`, `name`, `nickname?`, `type` (checking | savings | credit_card | loan | brokerage | retirement | cash | property | other), `currency`, `primary_space_id?`, `is_manual`, `include_in_net_worth`, `sync_enabled`, `hidden`, `last_four?`, `archived_at?`
- unique (`connection_id`, `external_id`)
- Manual accounts work exactly like synced ones, minus sync.

**balance_snapshots**: `id`, `account_id`, `date`, `balance_cents`, `available_cents?`, `source` (sync | manual)
- unique (`account_id`, `date`)
- SimpleFIN only reports current balances, so this table is the only source of balance history.

**transactions**: `id`, `account_id`, `external_id?`, `source` (simplefin | manual | csv), `import_batch_id?`, `date`, `posted_at?`, `transacted_at?`, `amount_cents`, `description_raw`, `payee?`, `memo?`, `pending`, `status` (active | removed), `private` (bool, default false), `needs_review` (bool)
- unique (`account_id`, `external_id`) where `external_id` is not null
- `private` controls what other Spaces see. See "Cross-Space visibility" below. Only editors of the account's primary Space (or an admin) can change it. Members of the Space a split lands in can never turn it off.

**splits**: `id`, `transaction_id`, `space_id`, `category_id?`, `amount_cents`, `memo?`, `reimbursable`, `reimbursed_at?`
- **Invariant:** for every active transaction, the sum of its splits' `amount_cents` equals the transaction's `amount_cents`. There is always at least one split.
- Reports, budgets and LilyPads read splits.

**categories**: `id`, `space_id`, `parent_id?`, `name`, `kind` (income | expense | transfer), `tax_line?`, `sort_order`, `archived_at?`
- New business Spaces are seeded with the Schedule C list from business_manager (with `tax_line`). New personal Spaces get a short starter list.

**transfer_links**: `id`, `from_transaction_id`, `to_transaction_id`, `created_by` (user | rule | auto)
- Linked transactions count as transfers in reports, not as spending or income.

**rules**: `id`, `space_id`, `name`, `priority`, `enabled`, `conditions` (JSON), `actions` (JSON)
- Conditions: description/payee contains or matches, amount range, account, direction.
- Actions: set payee, set category, move to Space, mark reimbursable, link as transfer.
- Rules run in priority order on new transactions, never on ones a user has edited.

**import_batches**: `id`, `account_id`, `filename`, `format` (csv), `column_map` (JSON), `status` (pending | review | done | error), `row_count`, `created_by`
- CSV import shows a review screen before committing, like business_manager's statement review.
- Duplicates are detected by account + date + amount + normalized description and flagged, not silently dropped.

### Platform

**settings**: `scope` (global | space | user), `scope_id?`, `key`, `value` (JSON). Primary key is (`scope`, `scope_id`, `key`).

**audit_log**: `id`, `at`, `actor_type` (user | system | lilypad), `actor_id`, `action`, `target_type?`, `target_id?`, `space_id?`, `meta` (JSON, never secrets)

**lilypad_installs**: `pad_id`, `version`, `tier` (official in v1), `permissions_granted` (JSON), `installed_by`, `installed_at`, `enabled`

**lilypad_space_enablement**: `pad_id`, `space_id`, `enabled_by`, `enabled_at`

**lilypad_migrations**: `pad_id`, `name`, `applied_at`

LilyPad-owned tables are named `lp_<padId>_<table>` and reference core rows by UUID. They use no foreign keys into core tables, so a LilyPad can be removed cleanly.

## Cross-Space visibility

A split can land in a different Space from its account's primary Space. Example: a business lunch on a personal card, split into the WibbitWorks Space.

Say a member of Space B has no access to the account's Space A:

| | `private = false` (default) | `private = true` |
|---|---|---|
| Their split (amount, category, memo) | visible | visible |
| Transaction date, payee, description | visible | visible |
| Account name | visible | hidden ("an account in another Space") |
| Transaction total | visible | hidden |
| Other splits | one line: "other Spaces: $X" | hidden |

They can never open the account, its other transactions or its balance.

## Porting from business_manager

| business_manager | Pond |
|---|---|
| `businesses` | `spaces` (type business) + `lp_business_profile` (entity type, EIN encrypted, fiscal year start, address) |
| `accounts` | core `accounts` |
| `categories` (Schedule C seeds) | core `categories`, seeded for business Spaces |
| `transactions` (positive amount + income/expense type) | core `transactions` + `splits`, signed cents |
| `statement_imports` / `statement_lines` | core `import_batches` + review flow (CSV in v1) |
| `people`, `salary_records` | `lp_business_people`, `lp_business_salary_records` (SSN encrypted, masked) |
| `documents` | `lp_business_documents`, files under `/data/files` |
