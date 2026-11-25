# Backup and restore

How it works and why: `backup-design.md`. M8a (below) is built; rclone is M8b.

## Backup contents

A backup is one file, `pond-backup-<instance>-<timestamp>.pond`. It's an [age](https://age-encryption.org)-encrypted (passphrase mode) tar archive holding:

```
manifest.json      first entry: format, Pond and schema versions, each LilyPad's applied
                   migrations, instance id, created_at, row counts, and a size and
                   SHA-256 for every other entry
pond.db            consistent SQLite snapshot (online backup, taken live)
keys/master.key    the master key, so encrypted fields can be read after a reinstall
files/             uploaded files (e.g. Business documents), still encrypted with the master key
```

- The standard age format means `age` and `tar` can open a backup without Pond.
- The reader accepts only these paths, each listed in the manifest with a matching checksum. Links, other file types and anything unexpected are refused.
- The master key goes **inside** the encrypted backup. Without it, a restore onto a new install couldn't read SimpleFIN URLs, SSNs or EINs.
- The **backup passphrase** is set by an admin (at least 12 characters), separate from login passwords. Pond keeps it encrypted with the master key so scheduled backups can run unattended. It is never shown again, logged or audited. **A lost passphrase means the backups cannot be opened.**

## Triggers

- **On demand:** Settings → Backups (password re-check).
- **Scheduled:** daily or weekly at a chosen time, to the backup folder. Defaults: daily at 02:00, keep 14. A run missed while Pond was off happens once, after it starts.
- Admins see a warning when the last scheduled backup failed, or the newest good one is older than 3 days (10 for weekly).

## Safety copies

Taken automatically **before core or LilyPad migrations** (database) and **before a restore** (database, key and files). They stay in `/data/backups`, readable only by Pond; the last 5 of each kind are kept. They are not passphrase-encrypted, never leave the data folder, and don't protect against a dead drive. **If one can't be made, Pond doesn't go ahead.**

## Destinations

| Destination | How |
|---|---|
| Download | Browser download of the file |
| Folder | Only the one folder mounted at `/backups` (`POND_BACKUP_DIR`), such as a NAS share or USB drive. The app has no path box. A marker file written when it is turned on must be there, so an unplugged drive makes backups fail instead of filling the SD card |
| rclone remote (M8b, not built) | The admin pastes an rclone setup. Only listed remote types and settings are accepted, they are encrypted at rest, and rclone only uploads, lists and deletes in one folder. See `backup-design.md` |

Tidying old copies deletes only files with this install's own backup names, and only after a newer backup has passed its check. Built-in Google Drive, Dropbox and Box buttons come later.

## Restore (v1: full overwrite)

1. An admin uploads a backup (2 GB limit, `POND_RESTORE_MAX_MB`) and enters its passphrase. On a **brand-new install**, the first-run screen offers this with the setup code from the server console; it closes once any account exists.
2. Pond checks free space, unpacks into a staging folder and checks checksums, database integrity, that the key opens the encrypted values, and that core migrations run on a copy. Nothing live changes.
3. Version check:
   - **Older schema:** allowed. Migrations run after the restore.
   - **Newer schema, or a LilyPad migration this Pond doesn't have:** refused, with "update Pond first."
   - **LilyPad this Pond doesn't ship:** warn; its data is restored and waits.
4. The screen shows what's inside. The admin confirms (password re-check) that **everything currently in Pond will be replaced**.
5. Pond takes a safety copy, marks the restore ready and stops itself.
6. At the next start, before opening the database, it swaps the staged data in. A journal records each step, so a power cut finishes or undoes the swap. If the restored database won't open, the old data is put back.
7. Everyone is signed out, and the restore is written to the restored audit log.

## Later: merge restore

Merging a backup into a live install without loss or duplicates is planned. It relies on every row having a stable UUID and on SimpleFIN `external_id`s. Don't add anything to the schema that would break those identities.
