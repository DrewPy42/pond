# Future ideas (not in v1)

A parking lot so good ideas aren't lost and v1 stays small ("Anything complicated stays out of v1": `scope-v1.md`). Add to it freely; nothing here is promised. Before building any of it, check it against the simplicity principle in `personal-finance-pad.md`.

## Bills (a LilyPad, v2)

Wanted: it would help managing real finances, and the owner has more ideas for it than fit in v1. Kept out of the Personal Finance pad so that pad stays simple, and because it deserves its own design. It fits the plugin model well as its own LilyPad.

Starting point (to be extended with the owner's ideas):
- **Detect recurring charges** from transaction history: same payee or similar text, similar amount, regular spacing (weekly, monthly, yearly).
- **Upcoming bills:** what is likely due in the next 30 days, with expected amounts; flag a bill that is missing or changed in amount.
- **Subscriptions list:** everything that recurs, with a yearly total.
- Link a bill to a category and show it against the budget.
- Notifications ("rent is due in 3 days") would need notification infrastructure that core doesn't have yet.

Open questions: how a person confirms or corrects a detected bill; paid-ness tracking (matched to a posted transaction); manual bills that haven't appeared in history yet; handling variable amounts (utilities).

_Owner ideas to add here:_ (none recorded yet)

## Reimbursables (v2)

Splits already have `reimbursable` and `reimbursed_at`, and rules can mark a split reimbursable, but no screen uses them. Deferred on purpose: the owner wants to understand the need better before designing it. Questions to answer first: who owes the money (an employer, a person, an insurer)? How is repayment recorded (matched to an incoming transaction, or marked by hand)? Should it affect reports (net of reimbursement)? Does it belong in core or a LilyPad?

## CRM (a LilyPad)

Requested by the primary user. Contacts, companies, notes and follow-ups, mainly for the business Space. It needs no financial permissions at all (see "Pads that aren't about money" in `lilypad-host-design.md`), so it is a good second pad to prove the platform handles non-financial pads. Needs `ctx.files` for attachments (M6) and likely field encryption for personal details. To refine with the requester before building.

## Personal Finance pad follow-ups
- **Several goals sharing one account** (each gets a portion of the balance). v1 goals follow a whole account or hand-added money.
- **Budgets on parent categories** that roll up their children.
- **Edit a goal's name, target or date in the UI** (the route exists; v1 screens only create and delete).
- **Pad UI helpers in the SDK** (money box, money amount, dialogs) so pads stop copying web components; also lets the pad follow the Space's currency instead of assuming USD.

## Starter categories per type of business
v1 gives every new business Space the same list of plain category names with no tax lines (`business-pad-design.md`). Later, Pond could ask the business type when the Space is created and offer a list that fits (a nonprofit has donations and grants, for example). Pre-filled tax lines for each tax form are a further step, and would need checking against the forms every year.

## Business Manager follow-ups
- **Attach receipts to transactions**, not just keep them in Documents.
- **1099 totals for contractors** (needs payments linked to people).
- **Payroll**: only if there is real demand; it is a large, regulated area.
- **Tax line presets per tax form** (see "Starter categories per type of business").

## Other ideas
- **Debt payoff planner** (snowball or avalanche) from loan and card balances plus interest rates.
- **Cash-flow forecast** from recurring items.
- **Budget alerts and notifications**, once there is a notification system.
- **Rollover and envelope budgeting**, only if people ask: both add concepts the simple budget deliberately avoids.
- **Undo for a CSV import** (soft-remove everything from one batch).
- **Moving a bank-fed account that has history to another Space.**
- Items already listed under "Later" in `scope-v1.md`: AI Assistant, Investments LilyPad, PDF import, passkeys, community LilyPads, merge restore, Tailscale, one-click updates, Pi image.
