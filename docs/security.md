# Security baseline

Pond holds a household's complete financial picture, plus SSNs and EINs for business payroll. The data is read-only with respect to the banks (SimpleFIN cannot move money), but it is highly private.

## Threat model

| Risk | Defense |
|---|---|
| Someone else on the home Wi-Fi | Login required on every route; HTTPS via Caddy; secure cookies; login rate limits |
| First-run admin hijack | Setup closes as soon as any account exists and refuses requests from other origins. **Until then, whoever can reach Pond can claim it** (see "First run") |
| Weak or stolen passwords | Argon2id; TOTP 2FA; re-enter password for sensitive actions |
| Household members seeing each other's data | Every API call checked against Space membership and role; deny by default |
| A copy of the database or files folder alone | Secrets and uploaded files encrypted with AES-256-GCM, key stored separately |
| Pi or drive stolen | **Not protected in v1:** the key is on the same drive as the data |
| Exposed to the internet | v1 is home-network only; no port forwarding |
| Bad or tampered update | Signed release images; automatic backup before migrations |
| Malicious LilyPad | v1 runs official pads only; API built for later isolation |
| Injection, XSS | zod validation; Drizzle only; strict CSP; no `v-html` with user data |
| Not knowing what happened | Audit log; secrets never logged |

## Authentication

- **First run:** there is no setup code (`simple-setup-design.md`). While Pond has no account, **anyone who can reach it** can create the admin account or restore their own backup onto it, and the same is true if it ever loses its database. So set Pond up as soon as it starts, and never make a new Pond reachable from the internet. What protects it, with nothing for the user to do: both close once any account exists (checked on every request, and creating the first admin is all-or-nothing); both refuse requests a browser marks as coming from another origin (`Sec-Fetch-Site`), including another app on the same machine, and Pond never allows another origin to send it JSON or files; Caddy serves only the configured address; and first-run restore is limited (see "Backups"). The setup screen warns anyone who has used this Pond before to stop.
- **Passwords:** Argon2id with OWASP-recommended parameters, tuned to stay under ~500 ms on a Pi 4. Minimum 12 characters, and a check against a small common-password list.
- **TOTP 2FA:** strongly encouraged, and required for admins. Secrets are stored encrypted, with one-time recovery codes.
- **Passkeys:** **not in v1**. WebAuthn needs HTTPS on a real hostname, and browsers reject IP addresses. A home-network-only install usually has neither. Passkeys come with remote access (Tailscale provides real certificates) or once local HTTPS with a trusted hostname is set up.
- **Rate limiting:** per IP and per username, with exponential backoff, and audit entries on lockout.
- **Recovery:** if someone is locked out, run `docker compose exec pond pond admin reset-password <user>` on the Pi. With the production setup, run it from the `deploy` folder. With the development setup, run `pnpm --filter @pond/server pond admin reset-password <user>`. It prints a temporary password, signs that user out everywhere and is audited. `--remove-2fa` also turns off their authenticator; an admin must set it up again at the next sign-in. Physical access to the device is the trust anchor: nothing in the web app can reset another person's password.

## Sessions

- Random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Only a hash of the token is stored.
- 12-hour idle timeout, 30-day absolute limit. Sessions are revoked on password change and when an admin disables the user.
- CSRF: SameSite=Strict plus a double-submit token on state-changing requests.
- **Re-authentication:** revealing an SSN or EIN, changing security settings, exporting a backup, or restoring requires the password again within the last 5 minutes (`sessions.reauth_at`).

## Authorization

- Admins can do everything. Everyone else acts through `space_members` roles:
  - **viewer:** read
  - **editor:** create and edit money data
  - **owner:** also manage members, Space settings and LilyPad enablement
- A Space always keeps at least one owner: the last one can't be removed or given another role.
- Only admins archive, restore or delete a Space. An archived Space answers 404 to every Space route (the shared middleware, so core and LilyPad routes alike) for everyone, admins included.
- Only admins can list users. A Space owner who isn't an admin adds someone by typing their exact username (`POST /api/spaces/:spaceId/members`). This tells an owner whether a username exists, which is accepted on a household install: only owners can ask, each addition is audited, and no user list is exposed.
- One middleware resolves the Space and role; route handlers declare the minimum role. There is a test for every route that a non-member gets 404 (not 403), so Space existence doesn't leak.
- Cross-Space split visibility follows `data-model.md`.

## Encryption at rest

- **Master key:** 32 random bytes. Default mode stores it in `/data/keys/master.key` with mode 0600, outside the database.
- **Whoever has the whole drive has the key,** and so can read everything, including bank connection details and tax IDs. The rest of the database (accounts, transactions) isn't encrypted at all. An optional startup passphrase is planned for later (`future.md`); it has not been built.
- **Field encryption:** AES-256-GCM with a random nonce per value, stored as `v1:<nonce>:<ciphertext>`. The version prefix allows key rotation later.
- **Encrypted fields:** `connections.access_url_enc`, `users.totp_secret_enc`, Business SSN and EIN, any API keys. In the UI, SSN and EIN show masked (`•••-••-1234`); the full value needs re-authentication.
- Full-disk encryption arrives with the prebuilt Pi image (later).

- **LilyPad files:** each file is encrypted with AES-256-GCM (random nonce, version byte), with its pad, Space and file ID authenticated so a moved file won't open. This protects a copy of the files folder on its own; in the default key mode it doesn't protect against theft of the whole drive.

## Backups

- A backup holds all data and the master key, protected only by its passphrase (age, scrypt). It is only as strong as that passphrase.
- Settings, making a backup and every restore step need an admin and the password re-check. A download is single-use and tied to the session that made it. On a new install, restore needs no account and closes once any account exists. Because anyone who can reach a new Pond can use it, a backup there may ask for no more than the scrypt work factor Pond writes (18; signed in, 20), and an address must wait after five failed checks. Someone on the network can still interrupt a first-run restore by uploading their own file.
- Uploaded backups are untrusted: a strict archive reader, a staging folder, and checksum, integrity, key and version checks all pass before anything is replaced.
- On this computer, backups are written only to the folder mounted for them. No local path is ever typed in the app.
- **Online storage (rclone):** a pasted setup is untrusted. Only listed services, settings and value shapes are accepted, because others can run programs, read server files or send sign-in tokens elsewhere, and Pond writes its own config from them. rclone runs without a shell, with a bare environment and only `copyto`, `lsjson` and `deletefile`. The setup is encrypted at rest and never returned, logged or audited; rclone's error text is never logged or shown. The program is pinned by checksum in the image and must be kept up to date.
- Whoever can sign in to the storage account can read or delete the files there. Reading their contents also needs the backup passphrase.
- Safety copies are unencrypted but never leave the data folder, beside the live database and key.
- The passphrase is never returned, logged or audited. Details: `backup-design.md`.

## Transport

- Caddy terminates TLS. In v1 it uses Caddy's internal certificate authority for a hostname like `pond.local`, or an IP address. The setup docs will explain how to trust the root certificate on household devices.
- No page or data is served over plain HTTP from the Pi to other devices: plain HTTP is only redirected, both on the HTTPS port and, when HTTPS is on 443, on port 80 (which can be turned off). Between Caddy and Pond it is plain HTTP on Docker's private network. In production, cookies are always `Secure`.
- HSTS is **off unless turned on** (`POND_HSTS`) and never covers subdomains, because it applies to every port on a host name.
- Caddy replaces any `X-Forwarded-For` a client sends, so sign-in limits and the audit log use the connecting address.
- No CORS. The web app and API share one origin.

## Application hardening

- Helmet headers and a strict CSP (no inline scripts). Vue templates escape output; `v-html` is banned on user data.
- zod on every input; Drizzle for every query; upload size and type limits; uploaded files stored by UUID, never by user-supplied name.
- `pnpm audit` in CI; the lockfile is committed; native dependencies limited and approved.
- pino with a redaction list (passwords, tokens, access URLs, SSN, EIN, cookies). Errors returned to the client never include stack traces.

- **LilyPad uploads and downloads** go through the host, never through pad code: nothing is read until sign-in, CSRF, role and enablement checks pass; compressed bodies are refused; the type is judged from the contents; downloads are attachments with `nosniff` and `no-store` and a cleaned name whose ending matches the content. Files are named by Pond's IDs only.
- **Business tax IDs** (the business's own and each person's) are encrypted with the core crypto module, masked in every response except the two reveal routes, which need the password re-check and are audited. They are never in logs, the audit log or exports. CSV exports escape cells that could run as spreadsheet formulas.
- **Password re-check** (5 minutes) guards reveals and other sensitive routes. The dialog belongs to the core web app; LilyPads never receive the password. (LilyPad code runs in the same browser page as core, which is acceptable only because v1 loads official pads alone.)

## Audit log

Recorded actions: logins (success and failure), lockouts, user and role changes, Space membership changes, connection add/remove, secret reveals, backup create/download/restore, LilyPad install/enable/update/uninstall, and settings changes. Each entry stores actor, target and Space, never secret values. Admins can view the log in Settings.

## Outbound requests (SimpleFIN)

Pond makes server-side requests to a URL an admin pastes (the SimpleFIN claim URL) and to the stored Access URL. Defenses: https only, port 443 only, no `localhost`, `.local`, `.internal`, private, link-local or bare hostnames, redirects refused, a request timeout and a response size cap. The Access URL carries credentials, so it is encrypted at rest, moved into an `Authorization` header for requests (never left in a URL), never logged, never returned by the API and never written to the audit log (`setupToken` and `accessUrl` are in the log redaction list).

## Updates

Release images are published to GHCR and signed with cosign; the update docs include the verify step. Pond takes a backup automatically before running new migrations.
