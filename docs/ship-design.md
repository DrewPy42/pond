# Ship (M9): design

**Status: approved 2026-11-26. Not built.**

The goal: someone with a Raspberry Pi can install Pond by following one page, use it over `https` at home, and update it with one command without losing data.

## Where things stand

Checked in the code and repository on 2026-11-26:

| Gap | Detail |
|---|---|
| **Pond can't run outside development** | There is only `Dockerfile.dev`. The server doesn't serve the built web app, and there is no Caddy or production compose file |
| **No licence file for Pond** | The README says AGPL-3.0, but only the SDK and template have a `LICENSE`. The repository is public, and GitHub shows no licence |
| **No versions or releases** | The version is `0.0.0` everywhere, and there are no tags |
| **No update notice** | In v1's scope; not built |
| **No audit log screen** | `security.md` says admins can view the log in Settings. Only the server route exists |
| **No signed images** | `security.md` promises them |
| **The image runs as root** | The development image sets no user |
| **Time zone** | A container normally reports UTC. Unless it is set, "02:00" backups and bank dates use UTC |
| **Node 22 is ending** | Images, CI and `.nvmrc` use Node 22. Its support ends 2027-04-30 (see "Sources") |
| **Never run on a Pi** | M8b's arm64 image was built and tested on a Mac. amd64 images haven't been built |

## Decisions (all approved 2026-11-26)

| # | Question | Decision |
|---|---|---|
| 1 | Split the milestone? | **Yes. M9a:** installable on a Pi, built there from source. **M9b:** published releases |
| 2 | How does the server run in the image? | **With `tsx`, as in development,** moved to a runtime dependency. No new package |
| 3 | Node version | **Node 24 everywhere,** changed first and on its own |
| 4 | Which user runs Pond? | **A normal user (ID 1000), not root** |
| 5 | HTTPS | **Caddy with its own certificate authority.** You trust its certificate once on each device |
| 6 | Where are images published? | **GitHub's registry, public. You choose the owner name before the first release** |
| 7 | Signing | **cosign in GitHub Actions, with no stored signing key** |
| 8 | Version numbers and update tags | **`0.9.x` while testing on the Pi, then `1.0.0`.** Installs follow the major version |
| 9 | Update notice | **On by default, with an off switch** |
| 10 | Audit log screen | **Build a simple read-only one** |
| 11 | Playwright browser tests | **Leave out of v1.** Test the shipped image instead |
| 12 | Licence files | **Add the AGPL-3.0 text, and ship third-party notices in the image** |

## M9a: installable

### The production image

- One multi-stage `deploy/Dockerfile`: install, build the web app, then a runtime stage with production dependencies only. It reuses the pinned rclone stage.
- The base image is pinned by digest.
- **The server serves the built web app** in production: static files, and `index.html` for page addresses. `/api` is never answered with a page. Files with hashed names are cached for a long time; `index.html` isn't. The security headers apply to both, and the content policy is checked in a real browser.
- `tsx` runs the TypeScript, as it has in every test so far. Compiling would be a second way of running the code, with its own failures. **Start-up time and memory are measured on the Pi;** if they're poor, we revisit.
- The `pond` command is built in, so `docker compose exec pond pond admin reset-password <username>` works as `security.md` says.
- A health check calls `/api/health`.
- It runs as user 1000 with a read-only filesystem except `/data`, `/backups` and a temporary folder, with no extra Linux privileges.

### The compose file

- Two services, `pond` and `caddy`. **Only Caddy publishes ports (80 and 443).** Pond's own port isn't reachable from the network.
- `restart: unless-stopped`, which restore relies on.
- **The time zone is required** in `.env`. Compose stops with a message if it's missing.
- Logs are rotated, so they can't fill the drive.
- Data and Caddy's certificate authority are in named volumes. Losing Caddy's volume would mean trusting a new certificate on every device.
- `/backups` is a folder you choose. **User 1000 must be able to write to it.** The install page gives the command, and how to mount a USB drive so it comes back after a restart. Some drive formats can't set ownership, so the page says which format to use.

### HTTPS

- The address is a setting, `pond.local` by default. An IP address also works.
- `pond.local` works when the Pi is named `pond` and the network passes local names. Not every device or router does, so the install page covers using an IP address.
- Caddy makes its own certificate authority. **Each device must be told to trust it,** with steps for macOS, Windows, iOS and Android, and a command that copies the certificate out. HTTP redirects to HTTPS.
- The install page says plainly: trusting this certificate means trusting your Pi to vouch for websites on that device. Its private key never leaves the Pi, and anyone who takes it could impersonate sites to those devices.
- No port forwarding. Home network only.

### Also in M9a

- **Audit log screen:** admin only, newest first, "load more", plain names for actions. No filters or export. It shows only what the route already returns, which never holds secrets.
- **Licences:** the root `LICENSE`, and a notices file in the image for what it ships, including rclone's.
- **Install page** (`docs/install.md`): from a fresh Pi to a first backup, then updating, password reset and restoring after a dead drive. It recommends an SSD and says a good drive isn't a backup.
- **Stale text:** README status, and the old theme wording in `scope-v1.md`.

## M9b: releases

### Building and publishing

- Pushing a version tag starts a workflow. **Only you create tags,** so only you publish a release.
- It builds **arm64 and amd64 on matching machines,** which GitHub offers free to public repositories, so nothing is emulated.
- **Release gate:** for each architecture, start the built image; load the web page and `/api/health`; open a database from each earlier schema version and migrate it; make a backup, restore it and restart; check rclone's version and that the user isn't root. **Nothing is published unless both pass.**
- Images go to GitHub's registry and are signed with cosign using the workflow's identity, so there is no signing key to store or lose. The signature is recorded in a public log, which is fine for a public project.
- Actions used by the release workflow are pinned to exact commits.
- **The owner name** (`DrewPy42`, or a WibbitWorks organization) is built into every install. Changing it later means every user edits their setup, so choose before the first release.

### Versions and updating

- `0.9.x` are test releases. `1.0.0` follows the checklist below.
- Each release is tagged exactly (`1.2.3`) and by major version (`1`). The compose file follows the major version, so `docker compose pull && docker compose up -d` gets fixes and new features but never a new major version by itself.
- The update page shows how to check the signature first. **The command doesn't check it automatically;** the docs say so.
- Going back to an older version isn't supported after a database change. The safety copy and your backups are the way back, and the page gives the steps.

### Update notice

- Once a day Pond asks GitHub for the latest release. It sends nothing about the household, only the request and the name "Pond". **GitHub does see your home's IP address,** which the install page states.
- **Off switch:** a setting in `.env`.
- Only the version number is read from the answer, and it must look like one. Pond builds the release notes link itself.
- Admins see "Pond 1.2.0 is available" with the link. Pond never updates itself. A failed check is silent.

### Browser tests

`testing.md` plans a few Playwright tests. They are left out of v1: it is a large new dependency, and the release gate tests what actually ships. Screens are still checked by hand in a browser. `testing.md` would be changed to say so.

## Before 1.0.0, on a real Pi

These can't be proved on a Mac. Each gets a recorded result.

1. Install from the page alone, on a fresh Pi.
2. HTTPS from a computer and a phone.
3. **Backup memory use and how long the server pauses,** at the current passphrase strength. Adjust it if needed.
4. Restore with the automatic restart, and restore onto a freshly installed Pi.
5. A USB drive: writing, unplugging it (the backup must fail loudly) and a reboot.
6. One real upload for each online service you'll use, then download and check it with restore, stopping before confirming.
7. **SimpleFIN with a real account:** confirm request limits and history depth (open since M3).
8. Cut the power while Pond is running, and during a restore.
9. Update from one `0.9` release to the next.
10. A security review of the whole app against `security.md`, fixing or documenting each difference.

## Risks

| Risk | Defence |
|---|---|
| A tampered or broken release | Signed images, a release gate on both architectures, tags created only by you, pinned base images, rclone and release actions |
| Pinned parts go out of date | The release page lists Node, Caddy and rclone to review at every release |
| Pond exposed to the internet | Only Caddy listens, with a local certificate; the install page says not to forward ports |
| A weak spot in the container | Normal user, read-only filesystem, no extra privileges |

## Not in M9

One-click updates and automatic rollback, a ready-made Pi image with disk encryption, remote access, the website, guided online storage setup (M8c, proposed separately in `guided-setup-design.md`).

## What I need from you

- **Do you have a Pi to test on** (a Pi 4 with 4 GB or newer)? Without one, M9a can be built but `1.0.0` shouldn't be released.
- For decision 6, the owner name (still open). It isn't needed until M9b.

## Docs to change when built

`architecture.md`, `security.md`, `testing.md`, `scope-v1.md` (M9a and M9b), `decisions.md`, `README.md`, and the new `install.md`.

## Sources

Looked up 2026-11-26.

- [Node.js release schedule announcement](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule). The Node 22 end date comes from search summaries that agree; confirm it against Node's published schedule before changing versions.
- [GitHub: arm64 runners for public repositories](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)
- [Caddy: running Caddy and trusting its local certificate](https://caddyserver.com/docs/running)
- Latest releases on 2026-11-26: Caddy 2.11.9, cosign 3.1.6. Exact versions are chosen when each is added.
