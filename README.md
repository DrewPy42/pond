# Pond

Self-hosted personal and business finance for your household, by WibbitWorks.

Pond pulls read-only data from your banks through your own SimpleFIN Bridge account and keeps everything on hardware you own, such as a Raspberry Pi. Personal and business finances live side by side in **Spaces**, and features are added through plugins called **LilyPads**.

Status: M0 (scaffold) in progress. See `docs/` for the spec and `docs/scope-v1.md` for what is planned for the first release.

## Develop

Requires Node 26+ and pnpm.

```bash
pnpm install
pnpm dev        # server on :3210, web on :5173
pnpm test
pnpm lint && pnpm typecheck
```

Or with Docker: `docker compose -f docker-compose.dev.yml up`.

## Backups and recovery

Set up backups in Settings → Backups. In Docker, mount the drive or share for backups at `/backups`. For online storage, the Docker image includes rclone; you make the sign-in with rclone on your own computer and paste it into Pond. When dependencies change, rebuild the development container:

```bash
docker compose -f docker-compose.dev.yml up -d --build --renew-anon-volumes
```

Forgot a password? Run this on the machine Pond runs on (add `--remove-2fa` for a lost phone). With Docker, put `docker compose -f docker-compose.dev.yml exec pond-dev` in front.

```bash
pnpm --filter @pond/server pond admin reset-password <username>
```

License: AGPL-3.0 (core); MIT (`packages/sdk` and the LilyPad template).
