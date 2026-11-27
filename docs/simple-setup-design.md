# Simpler setup: design

**Status: approved 2026-11-27. The setup code is removed (first change). rclone is not yet removed.**

Remove the first-run setup code and online backups through rclone. Both ask more of a home user than they're worth.

## Why

- **The goal is a ready-made Pi image:** write it to a drive, add the Wi-Fi details, plug it in and open Pond in a browser. Someone doing that may never open a terminal.
- **The setup code needs one.** It exists only in Pond's log. In the first Pi trial, the screen's "server console" was hard to find.
- **rclone needs one too,** on another computer, with a sign-in and a pasted result. The proposed guided setup (M8c) would still have had people copy an address from an error page.
- This follows "simple by default" in `CLAUDE.md`. Pond must still be secure; where a protection is too hard to use, we drop it, say what that costs and keep the protections that need no effort.

## Decisions (all approved 2026-11-27)

| # | Question | Decision |
|---|---|---|
| 1 | The setup code | **Remove it,** for first-run setup and first-run restore. Whoever opens a new Pond first sets it up |
| 2 | What protects a new Pond instead? | **Only things that ask nothing of the user** (see "Without the code") |
| 3 | rclone | **Remove it completely:** screens, server code, the program in both images and its settings. Not hidden behind "Advanced" |
| 4 | Online backup details already saved | **Delete them with a database migration** |
| 5 | Scheduled backups left with nowhere to go | **Warn until it's fixed** |
| 6 | Off-site backups | **Say plainly** that a backup kept at home won't survive a fire or theft, next to "Download a backup". No new reminders |
| 7 | The guided setup proposal (M8c) | **Drop it** |
| 8 | The Pi image | **Record it as a goal that guides choices now; build it later** |
| 9 | Order | **Two pull requests:** the setup code first, then rclone |

## Without the code

### What it did

It proved that the person setting Pond up controls the computer it runs on. **It was never part of any encryption.** The master key is created by Pond, and backups use their passphrase.

### What we give up

While Pond has no account, **anyone who can reach it** can:

- create the admin account, or
- restore their own backup onto it.

A new Pond holds nothing of yours. If someone else gets there first, you see a sign-in screen instead of setup, and you erase Pond and start again. This relies on **never making a new Pond reachable from the internet.**

The same applies if a Pond **loses its database** later: setup opens again. Someone could then set up an empty Pond that your family mistakes for yours. They'd get no old data from it, but could receive whatever is typed into it afterwards.

### What stays or is added

None of these needs anything from the user.

- Setup and first-run restore **close as soon as any account exists.** This is checked on every request, and creating the first admin stays a single all-or-nothing step.
- **Other websites can't run setup through your browser.** Pond accepts these requests only as JSON or a raw file, which a browser won't send across sites without permission Pond never gives. In addition, Pond will refuse them when the browser says they come from another origin (`Sec-Fetch-Site` other than `same-origin` or `none`), including another app on the same Pi. Browsers send that header over HTTPS and to `localhost`. A request without it is allowed. Tests cover both layers.
- Caddy passes requests on only for Pond's configured address.
- **Limits on first-run restore,** which anyone can reach on a new install:
  - After five failed checks from one address, that address must wait, as at sign-in.
  - The backup's passphrase strength setting may be **no higher than the one Pond writes** (scrypt work factor 18). Signed-in restore keeps today's higher limit of 20, which can need about 1 GB of memory.
  - The existing upload size limit and one-restore-at-a-time rule stay.
- The setup screen says: **"If you've used this Pond before, stop here. It can't find your data."**
- The install page says to set Pond up as soon as it starts, never to forward ports, and how to erase a Pond that someone else set up.

**Still possible on a new install:** someone on the network can interrupt your first-run restore by uploading their own file, or send backup files that make Pond check them. File checking, which was behind the code, becomes reachable without it. The existing strict checks on backup files still apply.

## Removing rclone

### What people keep

| Way | Automatic? | Survives a fire or theft? |
|---|---|---|
| Backup folder (a USB drive or network share) | Yes | Only if the share is somewhere else |
| Download a backup, then keep it anywhere, such as iCloud, Dropbox or Google Drive | No | Yes |

A downloaded backup is already encrypted with the backup passphrase.

**The real loss is automatic off-site backup.** A simpler way to do it can be considered later. It isn't planned or promised.

### What goes

- The online storage card, its routes and the `remote` backup destination.
- `apps/server/src/backup/remote/`, the test stand-in and their tests, including the real-rclone test.
- The rclone stage in both Dockerfiles, the test that keeps them alike, and `POND_RCLONE_PATH`. The system certificate package was added only for rclone, so it goes too; bank sync must be checked to work without it in the built image.

This also ends keeping a pinned rclone version up to date, and the problem of Google retiring rclone's shared sign-in.

### Existing databases and backups

- A new migration **deletes the two saved settings** (`backup.remote`, which holds the encrypted sign-in tokens, and `backup.remoteInfo`). It has a fixture and a test, as every schema change does.
- **Older backups still restore.** The restore checks the backup, then the migration deletes those settings. Pond stops including `backup.remote` in its list of encrypted values to check.
- Leftover status entries and audit log entries about online storage are kept and ignored.
- Older backups and safety copies **still contain the sign-in details,** along with the key that opens them. Anyone who set up online storage should remove rclone's access in that service's account settings. Pond has had no release, and the first Pi trial didn't set it up.

### Scheduled backups with nowhere to go

If the schedule is on and online storage was its only destination, today's warnings would say nothing and **backups would silently stop.** A new warning shows whenever the schedule is on and no destination is: "Scheduled backups are on, but there's nowhere to save them. Turn on the backup folder." The schedule isn't turned off silently.

## The Pi image (goal, not built here)

It stays outside v1 until you decide otherwise. These must be settled before building it:

| Need | Note |
|---|---|
| **Each Pi makes its own secrets** | The master key and Caddy's certificate authority must be created on first use. An image must never contain them, or every user would share private keys |
| **No default password; remote login off** | |
| **Wi-Fi** | Check what the usual Pi writing tool can set for a custom image before designing our own file |
| **Time zone** | Required in `.env` today. It would need choosing in the browser |
| **Address** | A name that works without editing files |
| **A USB backup drive** | Set up without a terminal |
| **Updates** | Today they need a terminal |
| **Trusting the certificate** | **Probably the hardest step left,** especially on phones. It needs its own design. Turning HTTPS off isn't proposed |

## Tests

- **Setup:** works with no code on an empty Pond; refused once any account exists, including two requests at once; refused with a cross-origin `Sec-Fetch-Site`; accepted without the header.
- **First-run restore:** the same cases, plus the failed-check limit and a backup with a higher work factor, refused before the passphrase is processed.
- **Migration:** both settings are gone and every other setting is unchanged; a backup made before the migration, with online storage set up, restores.
- **Warnings:** schedule on with no destination warns; turning the folder on clears it.
- **Image:** it builds without rclone and makes an HTTPS request to a public site's certificate chain successfully (no bank account needed).
- By hand in a browser, on a throwaway copy: setup, first-run restore and the backup screen.

## Docs to change when built

`security.md`, `backup-restore.md`, `backup-design.md` (note what was removed; its history stays), `architecture.md`, `testing.md`, `scope-v1.md` (M8b built then removed; online backups move to "Later"), `ship-design.md` (the release gate's rclone check, real-upload check and rclone notice), `guided-setup-design.md` (marked dropped), `future.md`, `decisions.md`, `README.md` and `.env.example`.

## Not in this change

Building the Pi image, changing how HTTPS or the certificate works, a new online backup method, and new backup reminders.
