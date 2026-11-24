# Personal Finance LilyPad (v1)

The first official LilyPad, and the one that proves the plugin API (see `lilypad-contract.md`). For personal Spaces. Scope was settled in discussion on 2026-11-22; see `decisions.md`.

## Principle: simple by default

Pond should feel simple to someone who has been put off by complicated budgeting software, while staying flexible enough to grow. For this pad that means:

- **Works with no setup.** Open it and see something useful. Nothing has to be configured before it does anything.
- **A small number of concepts.** A budget is an amount per category per month. A goal is a name and a target. Nothing else to learn.
- **Sensible defaults, not settings.** Add an option only when real use shows it's needed. When in doubt, leave it out and write it in `future.md`.
- **Plain words.** "Left to spend", not "variance". No accounting jargon.
- **Flexible underneath.** Simple screens sit on the same data the rest of Pond uses (splits and categories), so power can be added later without changing what people already know.

## In v1

### Budgets
- A monthly amount for each category you want to watch. Categories without a budget are simply not tracked.
- The page shows the current month: for each budgeted category, **budgeted, spent, left**, with a bar. Other months are reachable but not the focus.
- **Spent** is the sum of splits in this Space for that category and month. Transfers and income categories don't count as spending. A split moved to another Space stops counting here (which is the point of splits).
- **One-click start:** "Suggest a budget from the last 3 months" fills in amounts from actual spending, which the person can edit. No blank-page problem.
- Budgets carry forward month to month; change an amount and it applies from that month on.
- **Not in v1:** rollover of unspent money, envelope or zero-based budgeting, annual budgets, budgets on parent/child category trees.

### Savings goals
- A goal is a **name, a target amount, and an optional target date**.
- **Progress** comes from one of two choices, picked when making the goal:
  - **A linked account**: the goal counts that account's balance (or the portion assigned to the goal when several goals share one account).
  - **Contributions I add myself**: a simple list of amounts and dates.
- Shows progress and, with a target date, "about $X a month to stay on track".

### Dashboard widgets
"Budget this month" and "Goals" cards on the core dashboard.

### How it uses the LilyPad API
This is why the pad exists in M5: it exercises `ctx.core` (categories, transactions, balances), `ctx.db` (its own `lp_personal_*` tables), `ctx.settings` (per Space), `ctx.jobs` (a monthly job), `ctx.events` (`transaction.created`, `split.changed`), and these UI points: sidebar section, dashboard widgets, a Space settings tab, and a transaction detail panel showing the transaction's budget category and what is left.

## As built (M5b)

Code: `lilypads/personal` (pad id `personal`, tables `lp_personal_budgets`, `lp_personal_goals`, `lp_personal_contributions`). Personal Spaces only. It asks for three permissions: read transactions and categories, see accounts, see balances.

- **Budgets are stored as "from this month on".** A row says what a category's amount is from a month onward; the latest row at or before a month applies, so changing an amount never rewrites earlier months. An amount of 0 means "stop tracking from this month".
- **Spent** is `core.splits.sum` over the month, expense categories only, so transfers, income and splits moved to other Spaces never count. A refund reduces spending. Sub-categories are not rolled up into parents (not in v1).
- **Suggest a budget** averages the 3 months before the one on screen, rounded to the nearest whole dollar, skips categories with no spending, and saves nothing until the person presses "Use this budget".
- **Goals follow one source, chosen at creation:** an account's latest balance, or contributions the person adds (a negative amount records taking money back out). A goal tied to an account can't take hand-added money. "About $X a month" counts the current month and rounds up; it is worked out in the browser from the person's own date.
- **Extension points used:** sidebar (Budget, Goals), two pages, two dashboard cards, and a panel on the transaction dialog ("Groceries: $20.00 left of $400.00 in November").
- **Not used, on purpose:** pad settings, events and the monthly job. Nothing in v1 needs them (budgets carry forward by calculation, not by copying rows), so adding them would only add options. The template pad and the host tests already exercise those parts of the API.
- **Roles:** viewers can see everything; editors can change budgets and goals.

## Deliberately not in v1
Bills and subscriptions (a future LilyPad), reimbursables, debt payoff planning, cash-flow forecasting, budget notifications, rollover, envelope budgeting. See `future.md` for the notes on each.
