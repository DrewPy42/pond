# Ship (M9): design

**Status: approved 2026-11-26. M9a is partly built** (see "Built so far"). The amendment at the end (ports, no runner, HTTPS, certificates and the development setup) is approved too. Where it differs from the text above it, the amendment wins.

The goal: someone with a Raspberry Pi can install Pond by following one page, use it over `https` at home, and update it with one command without losing data.

## Built so far

- Node 26 everywhere.
- The development setup listens on this computer only (decision 18).
- The production image (`deploy/Dockerfile`), with web serving and the `pond` command. Tried on a Mac (arm64) with made-up data, as user 1000 with a read-only filesystem and no extra privileges: setup, both official apps, a document upload, a backup and a restore with the automatic restart. amd64 and a real Pi are untested.

- The compose file and Caddy (`deploy/compose.yml`), with decisions 13, 15 and 16. Tried on a Mac with made-up data, with test ports limited to that computer: the exported certificate verifies for a name and for an IP address and survives recreating the containers; the redirects; Secure cookies; a restore with the automatic restart and a 60 MB upload through Caddy; a faked `X-Forwarded-For` didn't change the address Pond records or get around the sign-in limit. **Not tried:** a Pi or any Linux host, trusting the certificate on a real device, a browser over this HTTPS setup, another device on the network, and `pond.local` name lookup.

As built:

- The redirect port is a second compose file, `compose.http-redirect.yml`, switched on by `COMPOSE_FILE` in `.env`. Compose can't publish a port only when another port is 443, so Caddy refuses to start, with a plain message, if the redirect is on and HTTPS is on another port.
- The backup folder is required, and Docker won't create it if it's missing. An unplugged drive is still caught by the marker file. **For the install page:** use a folder that exists even with the drive unplugged (such as the mount point itself); otherwise Pond may not start without the drive.
- Pond refuses to start with a time zone that doesn't exist.

Still to build in M9a: the audit log screen, licence files, the install page and the stale text.

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
| 3 | Node version | **Node 26 everywhere,** changed first and on its own. (First approved as Node 24; changed 2026-11-26, see below) |
| 4 | Which user runs Pond? | **A normal user (ID 1000), not root** |
| 5 | HTTPS | **Caddy with its own certificate authority.** You trust its certificate once on each device |
| 6 | Where are images published? | **GitHub's registry, public. You choose the owner name before the first release** |
| 7 | Signing | **cosign in GitHub Actions, with no stored signing key** |
| 8 | Version numbers and update tags | **`0.9.x` while testing on the Pi, then `1.0.0`.** Installs follow the major version |
| 9 | Update notice | **On by default, with an off switch** |
| 10 | Audit log screen | **Build a simple read-only one** |
| 11 | Playwright browser tests | **Leave out of v1.** Test the shipped image instead |
| 12 | Licence files | **Add the AGPL-3.0 text, and ship third-party notices in the image** |

## Node version (changed 2026-11-26)

The design first recommended Node 24 without saying that Node 26 had already become long-term support. [Node's published schedule](https://github.com/nodejs/Release/blob/main/schedule.json), read 2026-11-26:

| Version | Long-term support from | Maintenance from | Ends |
|---|---|---|---|
| 22 | 2024-10-29 | 2025-10-21 | 2027-04-30 |
| 24 | 2025-10-28 | 2026-10-20 | 2028-04-30 |
| 26 | 2026-10-28 | 2027-10-20 | 2029-04-30 |

**Node 26 was chosen:** it is supported a year longer, and the development Mac already ran it. It was tried on Linux arm64 before any file changed: both native add-ons (better-sqlite3 and argon2) load, the checks pass and the app starts. amd64 and a real Pi are still untested.

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

## Amendment (2026-11-26): sharing a Pi, HTTPS and certificates

The test Pi already runs another app in Docker.

| # | Question | Decision | Status |
|---|---|---|---|
| 13 | Ports | **Caddy's ports are settings in `.env`,** 443 and 80 by default. Pond brings its own Caddy and doesn't touch other apps | Approved |
| 14 | GitHub runner on the Pi | **None. A Pi installs and updates Pond as a user would** | Approved |
| 15 | Plain HTTP | **Pond never serves a page or data over plain HTTP** from the Pi to your devices | Approved |
| 16 | The browser's HTTPS-only rule (HSTS) | **Off unless you turn it on** in `.env`; never covering subdomains | Approved |
| 17 | Certificates | **Caddy's own authority by default.** A trusted certificate through your own domain or Tailscale comes later | Approved |
| 18 | Development setup | **Reachable only from the computer running it** | Approved |

### The test Pi

Checked 2026-11-26: 64-bit (`aarch64`), 7.6 GiB of memory, a 235 GB SSD as the system disk with 213 GB free (the owner confirmed it's an SSD), and only ports 22 and 5200 listening. So **80 and 443 are free,** and the defaults work. It has more memory than the 4 GB in "Reference hardware", so passing on it **doesn't show that a 4 GB Pi is enough.**

Docker publishes ports on IPv6 as well as IPv4. Where a home has public IPv6 addresses, only the router's firewall keeps the internet out. The install page says to check that it blocks incoming connections.

### Ports (13)

- With, say, `POND_HTTPS_PORT=8443`, the address is `https://<pi-name>.local:8443`. The address setting and the port are separate settings.
- The install page shows how to see which ports are taken. Pond's own port is still never published.
- A shared reverse proxy for several apps isn't set up or documented in v1. Serving Pond under a path such as `/pond` isn't supported.
- **Ports don't separate cookies.** Browsers send a hostname's cookies to every port on it. Pond's cookies are marked `Secure`, so they aren't sent over plain HTTP, but **another HTTPS app on the same hostname would receive Pond's sign-in cookie.** The install page says so: share a hostname only with apps you trust, or give Pond its own name.

### No runner (14)

- This repository is public. [GitHub says self-hosted runners should almost never be used for public repositories](https://docs.github.com/en/actions/reference/security/secure-use), because a pull request can run code on them. On this machine that would reach the money data and the master key.
- Release builds run only on GitHub's own machines. **No workflow in this repository may use a self-hosted runner.**
- Before M9b, a Pi builds from source (`git pull`, then compose with `--build`). After it, `docker compose pull && docker compose up -d`.
- Testing starts with **made-up data**. The real copy is a fresh install afterwards. Back up other apps on the Pi before the power-cut tests.

### HTTPS only (15)

- Caddy redirects plain HTTP that arrives **on the HTTPS port** ([`http_redirect`](https://caddyserver.com/docs/caddyfile/options)), so typing the address without `https` still works on any port.
- A separate HTTP port, which only redirects, is published **only when HTTPS is on 443,** and can be turned off.
- A redirect can't protect the first plain request: someone already on your network could answer it with a fake page. Pond's cookies are never sent over plain HTTP. A bookmark to the `https` address, and HSTS where it's on, close the gap.
- Between Caddy and Pond, traffic is plain HTTP **on Docker's private network inside the Pi**. Pond's port isn't published.
- In production, cookies are **always** `Secure`: `POND_COOKIE_SECURE=false` is ignored. (Today it is honoured.)

### HSTS (16)

- Pond **already** sends this header, through Helmet's defaults: one year, including subdomains.
- It makes a browser use HTTPS for **every port on that hostname** ([RFC 6797](https://www.rfc-editor.org/rfc/rfc6797), sections 1 and 8.3). If another app on the Pi uses plain HTTP under the same name, a browser that has trusted Pond's certificate would try `https` for it too, and it would **stop working in that browser** for up to a year.
- **The port Pond uses says nothing about what else shares the name.** Pond can have 443 while another app uses plain HTTP on another port. So Pond can't safely choose for itself, and the header is **off by default**. This changes what Pond sends today.
- The install page says to turn it on if Pond is the only web app on that name, or every one of them uses `https`. It never includes subdomains.
- Turning it off later doesn't make browsers forget at once. The page says so.
- Browsers don't apply it to IP addresses.

### Certificates (17)

**No public authority issues certificates for `.local` names,** and a private address can't be validated for one either. A certificate your devices already trust needs a real, public name:

| Option | What it needs | Costs and limits |
|---|---|---|
| **Caddy's own authority** (default) | Trust it once on each device | Free, works offline. The trust step is fiddly |
| **Your own domain** with Let's Encrypt, proved through DNS | A domain, a DNS provider with an API, and a name pointing at the Pi's home address. No ports opened | The domain's fee. A DNS key stored on the Pi. The name appears in public certificate logs. The standard Caddy image has no DNS provider modules, so it means a custom build. Some routers block public names that point to home addresses. Renewal needs the internet |
| **Tailscale** (`.ts.net` names) | Tailscale on the Pi and on every device | No domain needed, and [Caddy can fetch the certificate](https://tailscale.com/docs/integrations/web-servers/caddy/caddy-certificates). Machine and network names [become public](https://tailscale.com/docs/how-to/set-up-https-certificates). Adds a service Pond depends on, and how Caddy in Docker reaches it still needs testing |

Let's Encrypt certificates are getting shorter: [64 days by default from February 2027, 45 from February 2028](https://letsencrypt.org/2025/12/02/from-90-to-45), so renewal must be automatic.

Most households have neither a domain nor Tailscale, so the default stays. Tailscale is already under "Later" with remote access and passkeys; that's where trusted certificates fit best. A WibbitWorks service that hands out names and certificates isn't planned: it would have to be run for every household.

### Development setup (18)

`docker-compose.dev.yml` publishes ports 3210 and 5173 to the whole network, **over plain HTTP, with insecure cookies.** Anyone on the home network can reach the development copy and could read what is sent to it. **It will publish them to `127.0.0.1` only** (in M9a). To test from a phone, use the production setup.

## Sources

Looked up 2026-11-26.

- [Node.js release schedule announcement](https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule). Dates since confirmed against Node's published schedule (see "Node version").
- [GitHub: arm64 runners for public repositories](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)
- [Caddy: running Caddy and trusting its local certificate](https://caddyserver.com/docs/running)
- Latest releases on 2026-11-26: Caddy 2.11.9, cosign 3.1.6. Exact versions are chosen when each is added.
