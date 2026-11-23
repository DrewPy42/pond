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

## Deliberately not in v1
Bills and subscriptions (a future LilyPad), reimbursables, debt payoff planning, cash-flow forecasting, budget notifications, rollover, envelope budgeting. See `future.md` for the notes on each.
