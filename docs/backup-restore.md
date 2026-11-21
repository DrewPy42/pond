# Backup and restore

## Backup contents

A backup is one file, `pond-backup-<instance>-<timestamp>.pond`. It's an [age](https://age-encryption.org)-encrypted (passphrase mode) tar archive holding:

```
manifest.json      pond version, schema version, each LilyPad id + version,
                   instance id, created_at, row counts per table
pond.db            consistent SQLite snapshot (better-sqlite3 .backup(), taken live)
keys/master.key    the master key, so encrypted fields can be read after a reinstall
files/             uploaded files (e.g. Business documents)
```

- Using the standard age format means a backup can be decrypted with the `age` command-line tool even without Pond.
- The master key goes **inside** the encrypted backup. Without it, a restore onto a fresh install couldn't read SimpleFIN URLs, SSNs or EINs.
- The **backup passphrase** is set by the admin. It is separate from login passwords and is never stored in plain form. Pond keeps it encrypted with the master key so scheduled backups can run unattended. The UI must say plainly that **a lost passphrase means the backups cannot be recovered.**

## Triggers

- **On demand:** Settings → Backups → "Back up now" (requires re-authentication).
- **Scheduled:** daily or weekly at a chosen time, keeping the last N copies per destination (default 14).
- **Automatic:** before core or LilyPad migrations run (kept locally, last 5).

## Destinations (v1)

| Destination | How |
|---|---|
| Download | Browser download of the file |
| Folder | Any path mounted into the container: a NAS share or a USB drive (set in `docker-compose.yml`) |
| rclone remote | rclone ships in the image; the admin pastes an rclone remote config. This covers Google Drive, Dropbox, Box, S3 and more, without Pond handling any OAuth itself |

Built-in Google Drive, Dropbox and Box buttons come later.

## Restore (v1: full overwrite)

1. Admin uploads a backup or picks one from a destination, then enters the backup passphrase.
2. Pond decrypts the backup and reads `manifest.json`, then shows what it contains: date, versions, counts.
3. Version check:
   - **Older schema:** allowed. Migrations run after the restore.
   - **Newer schema than this install:** refused, with "update Pond first."
   - **LilyPad not installed:** warn, restore its tables anyway, and the pad shows as missing until installed.
4. The admin confirms, after re-authenticating, on a screen that states **everything currently in Pond will be replaced**.
5. Pond takes a safety backup of the current state, then stops sync and jobs, swaps in the database, master key and files, runs migrations, and restarts.
6. The restore is recorded in the audit log after the swap.

## Later: merge restore

Merging a backup into a live install without loss or duplicates is planned. It relies on every row having a stable UUID and on SimpleFIN `external_id`s. Don't add anything to the schema that would break those identities.
