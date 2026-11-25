# Business Manager and the M6 host additions: proposal for review

**Status: approved 2026-11-24, nothing built yet.** M6 is the Business Manager LilyPad. It needs three things the host doesn't have, so it is split the way M5 was:

- **M6a: host additions** (files, password re-check for pad routes, owner-only sidebar items).
- **M6b: the Business Manager pad** (profile, reports, people and pay, documents).

## Settled in discussion (2026-11-24)

- **Any kind of business.** Pond is meant to be used by anyone, so nothing in the pad may assume a sole proprietorship, a single-member LLC, or any particular owner.
- **The pad ships empty.** No business, people or sample records. Test data is added separately, and is always made up.
- **No data migration.** business_manager was only ever used in development.

## Decisions (approved 2026-11-24)

| # | Question | Decision |
|---|---|---|
| 1 | Starter categories for a new business Space | **Keep the category names, drop the Schedule C tax lines** (see "Categories and tax lines") |
| 2 | Who sees people, pay, tax IDs and documents? | **Space owners only** (this includes Pond admins, who act as owners). Viewers and editors see reports |
| 3 | Are uploaded files encrypted on disk? | **Yes, every pad file** |
| 4 | Which uploads are accepted? | **PDF, JPEG and PNG, up to 15 MB** |
| 5 | Tax year | **One optional setting, "tax year starts in", default January** |

The two security changes (the password re-check, and file upload and download) were reviewed and approved with the rest. Number 5 reverses earlier advice to leave the fiscal year out: once any kind of business is allowed, some will not use the calendar year.

## Categories and tax lines

Today `apps/server/src/ledger/categorySeeds.ts` gives every new business Space a list whose tax lines say "Schedule C, Line 8" and so on, and names one category "Meals (50% deductible)". Schedule C applies only to sole proprietors and single-member LLCs. For anyone else those labels are wrong.

**Decided:** keep a starter list of ordinary category names, so a new business has something to use right away; remove every tax line; rename the meals category to "Meals". Spaces that already exist are left alone, so no migration is needed. People can still type their own tax lines on the Categories page.

The intended use of the tax summary is to **hand it to an accountant**, who connects the categories to whatever forms the business files. Pond doesn't need to know tax forms, so tax lines are optional.

**Starter lists per type of business: not in v1.** It is possible (ask the business type when the Space is created and pick a list), but pre-filled tax lines would mean getting every form's line numbers right and keeping them current each year, which the accountant already does. It also adds a question to creating a Space. One general list serves v1; the idea is noted in `future.md`.

## M6a: host additions

### 1. Files (`files:store`)

A pad never handles raw bytes. The host receives, checks, stores and sends files, so every pad gets the same protections and `ctx` stays plain JSON (amendment A6).

**Upload.** A route declares that it takes a file:

```ts
ctx.router.post('/documents', {
  role: 'owner',
  query: documentFields,                                // name, type, tax year, person
  upload: { maxBytes: 15 * 1024 * 1024, types: ['pdf', 'jpeg', 'png'] },
}, async (req) => {
  await req.db.table('documents').insert({ file_id: req.file!.id, /* ... */ })
})
```

- The browser sends the file as the **raw request body**, with its details in the query string. **No new dependency** (no multipart parser).
- The host reads the body **only after** sign-in, Space role, pad enablement and the CSRF check pass, so a stranger can't make a Pi buffer 15 MB.
- The type is decided from the **file's first bytes**, never from its name or the browser's claim. Anything else is refused.
- `maxBytes` can't exceed a host ceiling of 25 MB.
- If the handler fails, the host deletes the file, so nothing is orphaned.

**Storage.** `/data/files/<padId>/<spaceId>/<fileId>`. Names are Pond's own UUIDs; the user's filename is only a column in the pad's table. A file can be reached only from the Space it was stored in.

**Encryption.** AES-256-GCM with the core master key, a random nonce per file, and a version byte so the format can change. The Space, pad and file IDs are authenticated with it, so a file moved to another folder won't decrypt. **What this protects:** a copy of the files folder on its own. **What it doesn't:** theft of the whole drive in the default setup, where the key is on the same drive. Backups already include both the key and the files.

**Download.** A route returns `req.files.download(fileId, filename)` and the host sends the file with:

- `Content-Disposition: attachment` (a file never opens inside Pond's own page),
- `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`,
- the filename cleaned of path and control characters.

**Delete.** `req.files.remove(fileId)`. Uninstalling a pad with "delete its data" removes its folder.

**SDK test host:** an in-memory file store, so pad tests need no disk.

### 2. Password re-check for pad routes

A route can add `reauth: true`. The host then applies the same `requireRecentReauth` that core uses (password entered within the last 5 minutes) and answers `403 reauth_required` otherwise.

- **The pad never sees the password.** When it gets `reauth_required`, Pond's web app (not the pad) shows the password box, calls `/api/auth/reauth`, and retries the request once.
- The host writes an audit entry for every successful call to such a route, whether or not the pad remembers to. Values are never logged.
- Responses are sent with `Cache-Control: no-store`.
- The web app has no re-check dialog yet, so this adds a shared one that core can reuse for backups in M8.

### 3. Owner-only sidebar items

A sidebar item or page can declare `role: 'owner'`, so viewers don't see links that would only fail. This is tidiness, **not** security: the server route is what enforces access.

## M6b: the Business Manager pad

Pad id `business`, business Spaces only. Permissions: **read transactions and categories, keep private details encrypted, store files**. It does not ask to change transactions (the example manifest in `lilypad-contract.md` does, and should be corrected).

**Works with no setup:** reports work immediately. The profile, people and documents are all optional.

### Business profile (owner only)
Legal name, business type, tax ID, address, phone, and the month the tax year starts. Every field is optional.

- **Business type:** sole proprietorship, partnership, LLC, corporation, S corporation, nonprofit, other. It is **a label only**. No calculation depends on it, so no kind of business is left out.
- The Space's own name remains the business's everyday name.

### Reports (viewer and up)
All totals come from splits in this Space, so a purchase on a personal card that was split into the business counts. Transfers never count.

- **Profit and loss:** any date range, income and expenses by category, and the net. Quick picks for this month, this quarter, this tax year and last tax year.
- **Tax summary:** one tax year, grouped by each category's tax line. Categories without a line are listed by name under "No tax line", so the report is useful before any are filled in.
- **Partly deductible categories:** an owner can mark a category with a percent (for example 50). The tax summary shows what was **spent** and what is **counted**. Nothing is marked by default, and it is stored in the pad's own table, not guessed from category names. The report says it is a record-keeping summary, not tax advice.
- **Uncategorized money** is shown on its own line with a count, and **left out of the totals** with a plain warning. Pond only has the net of these amounts, so adding them to income or expenses would be a guess.
- **CSV export** of a date range for an accountant: date, description, payee, amount, category, tax line. It includes only this Space's splits, and the privacy rules for other Spaces still apply. Text cells that start with `=`, `+`, `-` or `@` are escaped so a spreadsheet can't run them as formulas.
- **Dashboard card:** income, expenses and profit for the current tax year.

### People and pay (owner only)
- **A person:** name, relationship (owner, employee, contractor), email, phone, address, start and end dates, and a tax ID. Someone with a past end date is shown as former.
- **Tax ID:** encrypted at rest and shown as `•••••1234`. Showing it in full needs the password re-check and is audited. It is never in a list response, a log, the audit log or an export. Formats differ between countries and ID kinds, so Pond doesn't insist on one.
- **Pay history:** amount, how often (per year, month or hour), the date it took effect, and a note. It is a record, **not payroll**: no withholding and no totals. Wages in reports come from actual transactions.
- **Delete** removes the person, their pay history and their documents, after a confirmation that says so.

### Documents (owner only)
A file with a type (tax form, contract, receipt, ID, other), an optional tax year, person and note. List, filter, upload, download, delete. Linking a receipt to a transaction is not in v1.

### Tables
`lp_business_profile`, `lp_business_deductions`, `lp_business_people`, `lp_business_pay_records`, `lp_business_documents`. Money is integer cents. IDs are encrypted with `ctx.secrets`.

## Not carried over from business_manager

| Old behavior | Why not |
|---|---|
| Tax summary "salary total": adds up pay records | It adds yearly, monthly and hourly **rates** together, so the number means nothing |
| Meals labelled 50% deductible but totalled in full | Replaced by the partly deductible percent |
| User's filename used in the stored path | `security.md` requires storage by ID |
| Businesses, accounts, categories, transactions, statements | Core already does these; PDF statement import is "Later" |

## Tests

Functionality tests use fakes, as everywhere. The ones that matter most:

- **Files:** wrong type by content, too large, no CSRF token, wrong role, another Space's file ID, handler failure leaves no file, download headers, a tampered or moved file fails to decrypt.
- **Re-check:** refused without it and after 5 minutes, allowed within, audited, no value in any log or audit row.
- **Permission suite:** every new pad route is covered automatically through `createSpaceRouter`.
- **Pad:** report math against known splits, tax years that start mid-year, partly deductible rounding in cents, the tax ID never appearing in list or export responses, CSV formula escaping.
- **Migrations:** the pad's tables on real SQLite.

## Test data

The pad ships with none. When you want some, I can add clearly made-up records (invented names, and tax IDs that can't be real) to the database you point me to.

## Added to `future.md` when built
Receipts attached to transactions, 1099 totals for contractors, payroll.
