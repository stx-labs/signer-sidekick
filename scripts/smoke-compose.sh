#!/usr/bin/env sh
set -eu

# Start the default bridge Compose service on a non-default container port and reach
# it through a different published host port. This covers three regressions at once:
# the container must not bind loopback, the published port must map to the container
# port, and the image health check must probe SIDEKICK_HTTP_PORT rather than 3998.
# journald is Linux-host only, so the overlay replaces it for CI and Docker Desktop.

root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$root"

"$root/scripts/require-docker-compose-v2.sh" >/dev/null

http_port=13998
publish_port=23998
event_port=13700
event_publish_port=23700
project="signer-sidekick-compose-smoke-$$"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/signer-sidekick-compose-smoke.XXXXXX")"
overlay="$tmp/compose.smoke.yaml"
env_file="$tmp/smoke.env"
started=0

unset COMPOSE_FILE COMPOSE_PROJECT_NAME SIDEKICK_HTTP_HOST SIDEKICK_PUBLISH_ADDRESS

cleanup() {
  if [ "$started" -eq 1 ]; then
    docker compose \
      --project-name "$project" \
      --project-directory "$root" \
      -f "$root/compose.yaml" \
      -f "$overlay" \
      --env-file "$env_file" \
      down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

cat >"$overlay" <<'EOF'
services:
  sidekick:
    logging: !override
      driver: json-file
    restart: "no"
EOF

# The node RPC endpoint is intentionally dead: serve must still listen and answer
# /health/live when the configured node is unreachable.
cat >"$env_file" <<EOF
STACKS_NODE_RPC_URL=http://127.0.0.1:9
SIDEKICK_MANAGER_PRINCIPAL=SP000000000000000000002Q6VF78.signer-manager
SIDEKICK_AUTH_TOKEN=sidekick-compose-smoke-token-0001
SIDEKICK_NETWORK=mainnet
SIDEKICK_HTTP_PORT=$http_port
SIDEKICK_PUBLISH_PORT=$publish_port
SIDEKICK_EVENT_HTTP_PORT=$event_port
SIDEKICK_EVENT_PUBLISH_PORT=$event_publish_port
EOF

compose() {
  docker compose \
    --project-name "$project" \
    --project-directory "$root" \
    -f "$root/compose.yaml" \
    -f "$overlay" \
    --env-file "$env_file" \
    "$@"
}

rendered="$(compose config)"
case "$rendered" in
  *"SIDEKICK_HTTP_HOST: 0.0.0.0"*) ;;
  *)
    echo "Rendered Compose config did not bind the operator API to 0.0.0.0." >&2
    printf '%s\n' "$rendered" >&2
    exit 1
    ;;
esac
case "$rendered" in
  *"target: $http_port"*) ;;
  *)
    echo "Rendered Compose config did not use container port $http_port." >&2
    printf '%s\n' "$rendered" >&2
    exit 1
    ;;
esac
case "$rendered" in
  *"published: \"$publish_port\""*|*"published: $publish_port"*) ;;
  *)
    echo "Rendered Compose config did not publish host port $publish_port." >&2
    printf '%s\n' "$rendered" >&2
    exit 1
    ;;
esac

# Compose builds signer-sidekick:local only when it is absent; CI loads it beforehand.
# --wait gates on the image health check, so a check hardcoded to 3998 fails here.
started=1
if ! compose up -d --wait --wait-timeout 120; then
  compose logs >&2 || true
  compose ps >&2 || true
  echo "Compose service never became healthy on container port $http_port." >&2
  exit 1
fi

if ! curl --fail --silent --show-error --max-time 5 \
  "http://127.0.0.1:${publish_port}/health/live" >/dev/null; then
  compose logs >&2 || true
  echo "Published host port $publish_port did not reach /health/live." >&2
  exit 1
fi

container="$(compose ps -q sidekick)"
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
if [ "$health" != "healthy" ]; then
  compose logs >&2 || true
  echo "Health status was '$health'; expected healthy on SIDEKICK_HTTP_PORT=$http_port." >&2
  exit 1
fi

echo "Compose smoke passed: host $publish_port -> container $http_port, health $health."
