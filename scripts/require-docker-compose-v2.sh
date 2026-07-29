#!/usr/bin/env sh
set -eu

minimum_major=2
minimum_minor=24
minimum_patch=4

version="$(docker compose version --short 2>/dev/null || true)"
version="${version#v}"
version="${version%%-*}"

if [ -z "$version" ]; then
  echo "Docker Compose v2.24.4 or newer is required. Install the Docker Compose plugin; legacy docker-compose v1 is unsupported." >&2
  exit 1
fi

IFS=.
set -- $version
major="${1:-}"
minor="${2:-}"
patch="${3:-0}"

case "$major:$minor:$patch" in
  *[!0-9:]* | :* | *:: | *:)
    echo "Could not parse Docker Compose version: $version" >&2
    exit 1
    ;;
esac

if [ "$major" -lt "$minimum_major" ] || \
  { [ "$major" -eq "$minimum_major" ] && [ "$minor" -lt "$minimum_minor" ]; } || \
  {
    [ "$major" -eq "$minimum_major" ] &&
      [ "$minor" -eq "$minimum_minor" ] &&
      [ "$patch" -lt "$minimum_patch" ];
  }; then
  echo "Docker Compose v2.24.4 or newer is required; found $version." >&2
  exit 1
fi

echo "Docker Compose v$version is supported."
