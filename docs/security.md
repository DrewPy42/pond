# Security baseline

Pond holds a household's complete financial picture, plus SSNs and EINs for business payroll. The data is read-only with respect to the banks (SimpleFIN cannot move money), but it is highly private.

## Threat model

| Risk | Defense |
|---|---|
| Someone else on the home Wi-Fi | Login required on every route; HTTPS via Caddy; secure cookies; login rate limits |
| First-run admin hijack | Admin setup requires a one-time code printed to the server console/logs |
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

- **First run:** the server generates a one-time setup code and prints it to the console/logs. Creating the first admin requires that code. The code expires after use.
- **Passwords:** Argon2id with OWASP-recommended parameters, tuned to stay under ~500 ms on a Pi 4. Minimum 12 characters, and a check against a small common-password list.
- **TOTP 2FA:** strongly encouraged, and required for admins. Secrets are stored encrypted, with one-time recovery codes.
- **Passkeys:** **not in v1**. WebAuthn needs HTTPS on a real hostname, and browsers reject IP addresses. A home-network-only install usually has neither. Passkeys come with remote access (Tailscale provides real certificates) or once local HTTPS with a trusted hostname is set up.
- **Rate limiting:** per IP and per username, with exponential backoff, and audit entries on lockout.
- **Recovery:** if someone is locked out, run `docker compose exec pond pond admin reset-password <user>` on the Pi (until M9 builds that command into the image: `pnpm --filter @pond/server pond admin reset-password <user>`). It prints a temporary password, signs that user out everywhere and is audited. `--remove-2fa` also turns off their authenticator; an admin must set it up again at the next sign-in. Physical access to the device is the trust anchor: nothing in the web app can reset another person's password.

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
- Settings, making a backup and every restore step need an admin and the password re-check. A download is single-use and tied to the session that made it. On a new install, restore needs the console setup code and closes once any account exists.
- Uploaded backups are untrusted: a strict archive reader, a staging folder, and checksum, integrity, key and version checks all pass before anything is replaced.
- Backups are written only to the folder mounted for them. No path is ever typed in the app.
- Safety copies are unencrypted but never leave the data folder, beside the live database and key.
- The passphrase is never returned, logged or audited. Details: `backup-design.md`.

## Transport

- Caddy terminates TLS. In v1 it uses Caddy's internal certificate authority for a hostname like `pond.local`. The setup docs explain how to trust the root certificate on household devices. Plain HTTP redirects to HTTPS.
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
