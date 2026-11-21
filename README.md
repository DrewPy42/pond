# Pond

Self-hosted personal and business finance for your household, by WibbitWorks.

Pond pulls read-only data from your banks through your own SimpleFIN Bridge account and keeps everything on hardware you own, such as a Raspberry Pi. Personal and business finances live side by side in **Spaces**, and features are added through plugins called **LilyPads**.

Status: M0 (scaffold) in progress. See `docs/` for the spec and `docs/scope-v1.md` for what is planned for the first release.

## Develop

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev        # server on :3210, web on :5173
pnpm test
pnpm lint && pnpm typecheck
```

Or with Docker: `docker compose -f docker-compose.dev.yml up`.

License: AGPL-3.0 (core); MIT (`packages/sdk` and the LilyPad template).
