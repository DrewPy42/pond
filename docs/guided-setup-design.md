# Guided online storage setup (M8c): design

**Status: dropped 2026-11-27. Never approved or built.** rclone is being removed instead; see `simple-setup-design.md`. Kept as history.

## Why

M8b asks people to install rclone, answer its questions in a terminal and paste the result. Many people won't know how. M8c replaces that with screens in Pond for four services. No installing and no terminal.

## Decisions to approve

| # | Question | Recommendation |
|---|---|---|
| 1 | Which services get guided setup? | **Backblaze B2, S3-compatible storage, Dropbox and Box** |
| 2 | OneDrive and Google Drive | **Pasting only, for now** (see "Not in M8c") |
| 3 | Keep pasting? | **Yes, under "Advanced: paste an rclone setup"** |
| 4 | May Pond run a fourth rclone command, `authorize`, with its temporary sign-in server? | **Yes, with the limits below.** This changes M8b's approved "three commands, no server" rule |
| 5 | Use rclone's built-in app registration for Dropbox and Box? | **Yes.** People don't register anything. See "What this depends on" |
| 6 | How is it released? | **M8b first, then M8c** on its own branch |

## The screens

**Set up online storage** starts by asking which service: Dropbox, Box, Backblaze B2, S3-compatible storage, or "Something else" (Advanced). Each guided choice then asks only what it needs. Every path ends the same way: Pond checks the folder, then saves.

### Backblaze B2 and S3 (a form)

| Service | Fields |
|---|---|
| B2 | Key ID, application key, bucket name, folder |
| S3 | Provider (Amazon, Cloudflare R2, DigitalOcean, Wasabi, MinIO, Other), access key, secret key, bucket name, folder. Region for Amazon; server address for the others |

- The screen says to **make the bucket first** on the service's website. Pond doesn't create buckets, and sets `no_check_bucket` for S3.
- Secret fields are password boxes, are never shown again and are cleared when the dialog closes.
- The server turns the fields into a setup and sends it through **the same checks as a pasted one**. The form adds no way around them.
- Each field says what the value is. Pond doesn't quote menu names from the services' websites, which change.

### Dropbox and Box (sign in)

1. **Connect Dropbox.** Pond starts a sign-in and shows a button that opens the service's own sign-in page in a new tab.
2. The person signs in there and allows access. **Pond never sees their password.**
3. The browser then tries to open an address beginning `http://localhost:53682/` or `http://127.0.0.1:53682/`, and **shows an error such as "This site can't be reached".** The screen warns about this *before* step 1, with a picture: the error is expected.
4. They copy the whole address from the address bar, paste it into Pond and select **Finish**.
5. Pond completes the sign-in, checks the folder and saves.

If the browser runs on the same machine as Pond, without Docker, the page loads and says it worked. Pond notices and moves on without a paste.

This is not one click. A true one-click button would need WibbitWorks to register its own app with each service and run a public web address for the sign-in to return to. That is a service to operate, outside what a self-hosted app should depend on.

## How the sign-in works

1. Pond runs `rclone authorize <dropbox|box>` with no browser, the same bare environment as other runs, and an empty config.
2. rclone listens on `127.0.0.1:53682`. Pond asks that local address once, takes the redirect it returns, and **accepts it only if it is `https` on that service's own sign-in host**. That is the address the button opens. The `state` value in it is remembered.
3. From the pasted text, Pond reads **only** `code`, `state` and `error`. It **never requests the pasted address.** It checks the `state` matches, then builds its own request to `127.0.0.1:53682` from those values.
4. rclone trades the code for a token and prints it. Pond takes the token, builds a setup from it and applies the usual checks.
5. rclone's other output and its web pages are never logged or shown.

### Limits

- Admin only, with the password re-check to start and to finish.
- **One sign-in at a time,** tied to the session that started it. Starting again cancels the earlier one.
- It is stopped after **10 minutes**, on cancel, on success, on failure, before a restore, and when Pond stops.
- The sign-in server is reachable only from where Pond runs. **The port is not published** in the compose file.
- `error=access_denied` is reported as "You didn't allow access." Any other failure gets a plain message and a fresh start.
- Audited: started, finished or failed, with the service name only. The pasted address, code and token are never logged or audited. `code` and `state` are added to the log redaction list.
- Until Pond's folder check passes, an existing working setup is left as it is.

### Risks

| Risk | Defence |
|---|---|
| A pasted address used to make Pond request something (SSRF) | The address is never requested; only three values are read from it |
| Someone else's sign-in slipped in, so backups go to their storage | `state` must match the sign-in this admin session started. The person pastes only from their own browser. The screen shows the service and folder before saving |
| The pasted address leaks | The code in it works once and briefly. It is never stored or logged |
| Something else on the same machine reaches the sign-in server | It listens only locally, needs the matching `state`, and exists for minutes. Anyone with local access already has Pond's data and key |
| rclone changes how `authorize` prints or behaves | The version is pinned. A real-rclone test covers starting, the redirect host and a wrong `state`; the update steps include one real sign-in per service |

## What this depends on

- **rclone's own app registrations** for Dropbox and Box. They are shared by everyone who uses rclone, so a service could limit or withdraw them. This is already true of a pasted setup made with rclone's defaults. Someone with their own app can still paste a setup.
- **People copying an address from an error page.** It is the awkward step. If real use shows it's too hard, we'd revisit, not add workarounds first.

## What has and hasn't been checked

Checked with rclone 1.76.0 on 2026-11-26, without contacting any service:

- For Dropbox and Box, `authorize` provides a local link that redirects to the service's `https` sign-in page, with a `state` value.
- A request with the wrong `state` is refused.
- From the source: the sign-in server listens on `127.0.0.1:53682`, reads `code`, `error` and `state`, and on success `authorize` prints just the token.

**Not checked:** a complete sign-in, since it needs a real account. So the first build step is **one real Dropbox sign-in by you** with a small trial, before any screens are built. Box needs its own before it is offered. A service that can't be tried isn't offered as guided.

## Not in M8c

- **OneDrive.** Sign-in gives only a token. rclone then asks Microsoft which drives the account has and you choose one. That means more rclone steps or calling Microsoft directly, and it can't be tested without an account.
- **Google Drive.** rclone 1.76.0's documentation says its shared Google app **is being retired and will stop working during 2026**, so each person must create their own app with Google. A button in Pond can't remove that. (Whether the shared app still works today hasn't been tested.)
- **Both stay available by pasting.** For Google Drive, the Advanced screen says that you need your own Google app, with a link to rclone's instructions. Pond already accepts `client_id` and `client_secret`.
- Pond's own app registrations or a sign-in relay service.
- Choosing a bucket or folder from a list, and creating buckets.

## Tests

- **Forms:** each field combination produces the expected setup; hostile values (line breaks, `%(`, `http://` addresses) are refused by the same checks.
- **Sign-in, with a fake `authorize`:** wrong or missing `state`, addresses on other hosts, extra values ignored, denial, timeout, cancel, a second start, another session trying to finish, no rclone, and that the old setup survives every failure.
- **Real rclone:** it starts, redirects to the expected host and refuses a wrong `state`; the process and port are gone afterwards.
- **By hand:** one real sign-in per guided service, then upload, download the file and check it with restore, stopping before confirming. B2 and S3 can also be tried against a local test server, but each offered service still needs one real check.

## Docs to change when built

`backup-design.md` (the three-command rule), `backup-restore.md`, `security.md`, `decisions.md`, `scope-v1.md` (add M8c), `future.md` (guided OneDrive and Google Drive).
