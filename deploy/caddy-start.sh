#!/bin/sh
# Checks the settings, so a mistake gives a plain message in `docker compose logs caddy`.
set -eu

case "$POND_ADDRESS" in
  '' | */* | *:* | *' '*)
    echo "POND_ADDRESS must be only a name or an IPv4 address, like pond.local or 192.168.1.20." >&2
    echo "Leave out https:// and the port." >&2
    exit 1
    ;;
esac

if [ "$POND_HTTP_REDIRECT" = true ] && [ "$POND_HTTPS_PORT" != 443 ]; then
  echo "The plain-HTTP redirect is only for HTTPS on port 443, but HTTPS is on $POND_HTTPS_PORT." >&2
  echo "In .env, remove ':compose.http-redirect.yml' from COMPOSE_FILE." >&2
  exit 1
fi

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
