# Backups and restore (M8): design

**Status: approved 2026-11-24, nothing built yet.** This turns `backup-restore.md` into a design that can be built. It keeps that spec's shape and says where I'd change it, and why.

A backup holds **everything**: all financial data, the files, and the master key that unlocks the encrypted fields. Restore **replaces** everything. Both need your explicit review.

## Decisions (all approved 2026-11-24)

| # | Question | Decision |
|---|---|---|
| 1 | Split the milestone? | **Yes. M8a:** backup, restore, schedule, folder and download, safety copies, password reset. **M8b:** rclone remotes |
| 2 | Add the `age-encryption` library? | **Yes** (see "Encryption") |
| 3 | Write our own small `tar` code instead of adding a library? | **Yes** (see "The archive") |
| 4 | Must the automatic safety copies be encrypted? | **No. They never leave the data folder** (see "Safety copies") |
| 5 | Restore on a brand-new install, from the first-run screen? | **Yes. The spec leaves this out, and it is the main disaster case** |
| 6 | How is restore applied? | **Checked and staged while running, swapped in at the next start** |
| 7 | Where may a "folder" destination write? | **Only to one folder set up in Docker, never a path typed in the app** |
| 8 | rclone settings (M8b) | **Accept only a fixed list of remote types and settings** |
| 9 | Password recovery | **Add the reset command in M8a** |

## What the spec gets wrong or leaves out

1. **The `age` command can't run unattended with a passphrase.** Its built-in passphrase mode asks at the keyboard. Scripting it needs a separate add-on program (`age-plugin-batchpass`) that not every system ships.
2. **No way to restore onto a new install.** Restore step 4 needs a signed-in admin, but after a dead SD card there are no accounts.
3. **"Restarts" has no mechanism.** The server holds the database open, and the development setup has no Docker restart policy.
4. **Safety copies need a passphrase that may not exist.** The spec takes a backup before every database change, including on installs where nobody has set one.
5. **A pasted rclone setup can run programs.** Some rclone options start commands on the machine, for example WebDAV's `bearer_token_command` and SFTP's `ssh`. Others (`local`, `alias`) reach the server's own files. Pasting that text into Pond as written would let anyone who got hold of an admin session run code on the Pi.
6. **A missing USB drive fails silently.** If the drive isn't mounted, writing to its folder succeeds on the SD card instead.
7. **The `backup.before` event** in `lilypad-contract.md` was never built and isn't needed: Pond copies pad tables and files itself. I'd remove it from the contract.

## M8a: the design

### Encryption

Use **`age-encryption`**, the TypeScript version of age by age's author (BSD-3-Clause, plain JavaScript with no native code, so nothing to compile for the Pi).

- It takes a passphrase from the program and works on streams, so a large backup never has to fit in memory.
- The output is the standard age format, so the spec's promise holds: **you can open a backup with the ordinary `age` command** (which asks for the passphrase) and `tar`, without Pond. A test will check this against the real tool wherever it's installed.
- **Cost:** it brings five small cryptography packages with it. It is young (version 0.3.1).
- **Passphrase strength has a price.** The step that slows down passphrase guessing needs a lot of memory (about 256 MB at the strength age commonly uses). I'll measure time and memory on a Raspberry Pi before fixing the setting, and won't claim a figure before then.
- Alternative: install the `age` program and its add-on in the image. That means two more programs to keep patched, and passing the passphrase between processes.

### The archive

A plain `tar` inside the age file, as the spec says. Node has no `tar` built in. I'd write a small one (as with the CSV reader): it only needs ordinary files. The reason is safety as much as size: the reader **accepts only the exact paths a Pond backup contains** and refuses links, absolute paths, `..`, duplicates and anything unexpected, so a crafted backup can't write outside the staging folder. The standard `tar` command must be able to unpack what we write, and a test checks that.

`manifest.json` comes **first**, so Pond can show what's inside without unpacking everything. It lists: format version, Pond version, core schema version, each LilyPad's applied migrations, instance id, time, row counts, and a size and SHA-256 for every other entry.

### Taking a backup

1. Snapshot the database with SQLite's online backup, which is safe while Pond is in use.
2. Copy the files. Pond **holds back file deletions** until the backup finishes, so the snapshot never points at a file that's gone. New files that arrive meanwhile are harmless extras.
3. Stream archive → encryption → a temporary file, then rename it, so a half-written backup never looks finished.
4. **Check it** by decrypting it again and comparing every checksum. A backup that can't be read back counts as failed.

One backup runs at a time. Every backup, success or failure, is audited without the passphrase.

### The passphrase

- Set by an admin, **at least 12 characters**, typed twice, after a password re-check.
- Stored encrypted with the master key so scheduled backups can run. It is never shown again and never logged.
- The screen says plainly: **if you lose it, your backups can't be opened.** Pond can't recover it.
- Changing it affects new backups only. Older ones still need the old one.

### Schedule, destinations and warnings

- **Set-up is one screen:** set a passphrase, and optionally turn on the schedule. Defaults: **daily at 02:00, keep 14**.
- **Download:** "Back up now" (password re-check), then your browser saves the file.
- **Folder:** Docker mounts one folder at `/backups`. Pond writes only there; the app has no path box. When you turn it on, Pond puts a marker file there. **If the marker is missing** (drive unplugged, share not mounted), the backup **fails loudly** instead of filling the SD card.
- **Old copies:** only files carrying this install's id and Pond's own name pattern are ever deleted, and only after a newer backup has passed its check.
- **Warnings:** admins see a banner when the last scheduled backup failed or the newest good one is more than 3 days old. A backup that fails unnoticed is the real risk.

### Safety copies

Taken automatically **before any core or LilyPad database change** and **before a restore**. They stay in `/data/backups`, readable only by Pond, and the last 5 of each kind are kept.

- **Not passphrase-encrypted.** They sit beside the live database and the master key, so encrypting them adds no protection, and requiring a passphrase would mean no safety copy on installs that haven't set one. They are **never** copied to a destination or offered for download.
- Before a database change: the database. Before a restore: database, key and files (files are never edited in place, so they can be linked rather than copied).
- **If a safety copy fails, Pond doesn't go ahead.** It stops with a message instead of changing the database unprotected.
- They protect against a bad update, **not** against a dead drive.

### Restore

1. Upload the backup (streamed to disk) and type its passphrase. Pond first checks there's enough free space.
2. Pond unpacks into a **staging folder** and checks everything: the checksums, the database's integrity, and that **the key in the backup really opens that database's encrypted values**.
3. **Version check:** older is fine. **Newer is refused**, whether it's the core schema or any LilyPad migration this Pond doesn't have. A pad that this Pond doesn't ship at all gets a warning; its data is restored and waits.
4. It shows what's inside. The admin re-enters their password and confirms that **everything now in Pond will be replaced**.
5. Pond takes a safety copy, marks the staged restore as ready, and **stops itself**.
6. **At the next start, before opening the database,** it swaps the staged data in, then runs migrations. The swap records each step, so a power cut during it finishes or rolls back on the following start.
7. Afterward, **everyone is signed out**, and the restore is written to the restored audit log.

Docker's restart policy brings Pond back (M9 sets it; I'll add it to the development setup). If you run Pond another way, the screen tells you to start it again. Nothing is changed until that start, and an invalid backup never gets that far.

**On a new install:** the first-run screen offers "Restore from a backup". It needs the **setup code from the server console**, as creating the first admin does, plus the file and passphrase. It is closed once any account exists. You sign in with the accounts and authenticator from the backup.

**Upload limit:** 2 GB by default, adjustable by a server setting.

### Password reset

Run on the machine itself, since access to it is already the root of trust:

```
docker compose exec pond pond admin reset-password <username>
```

It prints a one-time temporary password, signs that user out everywhere and writes an audit entry. `--remove-2fa` also turns off their authenticator, for a lost phone; an admin must set it up again at the next sign-in. It does **not** appear anywhere in the web app. (Before M9 builds the `pond` command into the image, it runs as a package script.)

## M8b: rclone remotes

- Ship a **specific, current rclone release** in the image, checked against its published checksum. This adds a program to the image and needs your approval when we get there.
- **Allow-list, not block-list:** Pond reads the pasted text and accepts only chosen remote types (to start: Google Drive, Dropbox, Box, OneDrive, S3-compatible, Backblaze B2) and, for each, only chosen settings. Anything else is refused by name. Adding a type or setting later is a deliberate change.
- The settings hold login tokens, so they are encrypted at rest. rclone **rewrites them when a token refreshes**, so Pond must give it a private temporary copy, save any change back encrypted, and delete the copy.
- rclone is only ever run to upload, list and delete in one chosen folder. Its remote-control server is never started.
- Restoring from a remote means downloading the file yourself and uploading it, unless real use shows a button is needed.

Splitting this off lets M8a protect your data sooner, and gives the rclone security work its own review. rclone stays in v1.

## Security summary (reviewed and approved)

| Risk | Defence |
|---|---|
| Stolen backup file | age encryption with a passphrase that isn't a login password; strength is only as good as the passphrase |
| Crafted backup used to write files or run code | Strict archive reader, staging folder, checksums, integrity and version checks before anything is replaced |
| Stolen admin session | Password re-check for backup, download, passphrase, destination and restore; no typed paths; rclone allow-list |
| Restore abused on a new install | Setup code from the server console; closed once any account exists |
| Secrets in logs | Passphrase, rclone settings and key never logged or audited |

**Not protected:** someone who has the Pi itself has the live data and the key (unchanged from today). `security.md` also describes an optional startup passphrase for the master key; it has never been built and has no milestone. Still to be confirmed: whether it moves to "Later".

## Tests

- **Round trip:** back up a populated install, restore into an empty one, and compare every table, file and encrypted value.
- **Older backup:** restore each earlier schema version and migrate (the existing migration fixtures).
- **Refusals:** wrong passphrase, truncated or altered file, hostile archive paths and links, newer schema, mismatched key, not enough space.
- **Interruption:** stop at each step of the swap, restart, and check the result is entirely old or entirely new.
- **Destinations:** missing marker, retention never touching other files, safety-copy failure stopping a migration.
- **Compatibility:** open our backup with the real `age` and `tar` tools where installed.
- **Password reset:** the command's effects, and that no web route reaches it.

## Changes to other docs as M8a is built

`backup-restore.md` (safety copies, new-install restore, staged swap, folder rule, rclone limits), `security.md`, `lilypad-contract.md` (`backup.before`), `scope-v1.md` (M8a and M8b), `decisions.md`.
