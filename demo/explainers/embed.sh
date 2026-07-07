#!/usr/bin/env bash
#
# embed.sh — upload a polished HTML explainer to Notion and embed it as a real
# interactive HTML block on a page.
#
# Usage:
#   ./embed.sh <html-file> <page-id>
#
# Flow (two Notion API calls):
#   1. Upload the .html via the File Upload API  -> yields a file_upload id.
#   2. Append an `embed` block of type file_upload to the page's children.
#      Notion renders the uploaded .html as a sandboxed, interactive HTML block.
#
# Notion returns 429 (rate limited) heavily under load. Every call is wrapped in
# a bounded retry-with-backoff loop so this is safe to run repeatedly / in a
# demo.
#
# Requires: `ntn` (Notion CLI) on PATH, with an integration that has access to
# the target page.

set -euo pipefail

# ---- args -------------------------------------------------------------------

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <html-file> <page-id>" >&2
  exit 2
fi

HTML_FILE="$1"
PAGE_ID="$2"

if [ ! -f "$HTML_FILE" ]; then
  echo "error: html file not found: $HTML_FILE" >&2
  exit 1
fi

FILENAME="$(basename "$HTML_FILE")"

# ---- retry helper -----------------------------------------------------------

# Number of attempts before giving up on a single call.
MAX_ATTEMPTS="${EMBED_MAX_ATTEMPTS:-6}"
# Base backoff in seconds; grows on each 429.
BACKOFF_BASE="${EMBED_BACKOFF_BASE:-30}"

# run_with_retry <label> <cmd...>
# Runs the command, capturing stdout to $RETRY_OUT. Retries on failure with a
# fixed-ish backoff (Notion 429s clear after tens of seconds).
#
# If $RETRY_STDIN is set to a file path, the command's stdin is reopened from
# that file on every attempt (so retries of a stdin-consuming command like
# `ntn files create` re-read the full file rather than an exhausted fd).
run_with_retry() {
  label="$1"
  shift
  attempt=1
  while :; do
    if [ -n "${RETRY_STDIN:-}" ]; then
      RETRY_OUT="$("$@" 2>/tmp/embed_err.$$ <"$RETRY_STDIN")" && { rm -f "/tmp/embed_err.$$"; return 0; }
    elif RETRY_OUT="$("$@" 2>/tmp/embed_err.$$)"; then
      rm -f "/tmp/embed_err.$$"
      return 0
    fi
    err="$(cat "/tmp/embed_err.$$" 2>/dev/null || true)"
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      echo "error: $label failed after $attempt attempts" >&2
      echo "$err" >&2
      rm -f "/tmp/embed_err.$$"
      return 1
    fi
    wait_s=$(( BACKOFF_BASE + (attempt - 1) * 15 ))
    echo "warn: $label attempt $attempt failed (likely 429); backing off ${wait_s}s..." >&2
    echo "$err" | head -3 >&2
    sleep "$wait_s"
    attempt=$(( attempt + 1 ))
  done
}

# ---- 1. upload --------------------------------------------------------------

echo "==> uploading $FILENAME ..." >&2
RETRY_STDIN="$HTML_FILE"
run_with_retry "upload($FILENAME)" \
  ntn files create --filename "$FILENAME" --content-type text/html --plain
RETRY_STDIN=""

# file_upload id is column 1 of the TSV output.
FILE_UPLOAD_ID="$(printf '%s\n' "$RETRY_OUT" | head -1 | cut -f1)"

if [ -z "$FILE_UPLOAD_ID" ]; then
  echo "error: could not parse file_upload id from upload output:" >&2
  printf '%s\n' "$RETRY_OUT" >&2
  exit 1
fi

echo "    file_upload id: $FILE_UPLOAD_ID" >&2

# ---- 2. embed ---------------------------------------------------------------

echo "==> appending embed block to page $PAGE_ID ..." >&2
BODY="$(printf '{"children":[{"type":"embed","embed":{"type":"file_upload","file_upload":{"id":"%s"}}}]}' "$FILE_UPLOAD_ID")"

run_with_retry "embed($PAGE_ID)" \
  ntn api "/v1/blocks/$PAGE_ID/children" -X PATCH -d "$BODY"

# Report the new block id if jq is available.
BLOCK_ID="$(printf '%s\n' "$RETRY_OUT" | jq -r '.results[0].id // empty' 2>/dev/null || true)"
echo "    embed block id: ${BLOCK_ID:-<created>}" >&2

echo "OK: embedded $FILENAME into page $PAGE_ID" >&2
# Emit machine-readable result on stdout: <file_upload_id>\t<block_id>
printf '%s\t%s\n' "$FILE_UPLOAD_ID" "${BLOCK_ID:-}"
