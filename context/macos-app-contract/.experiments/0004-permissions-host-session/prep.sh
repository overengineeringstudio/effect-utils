#!/bin/sh
set -eu
[ "$#" -eq 1 ] || { printf 'usage: %s PRIVATE_CONFIG_JSON\n' "$0" >&2; exit 64; }
exec python3 "$(dirname "$0")/session.py" prep "$1"
