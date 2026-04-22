#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../../.." && pwd)"
PKG_DIR="$ROOT_DIR/packages/@overeng/notion-react"
SESSION="${NOTION_VIDEO_SESSION:-notion-demo-video}"
WINDOW_INDEX="${NOTION_VIDEO_WINDOW_INDEX:-1}"
TOP_PANE="${SESSION}:${WINDOW_INDEX}.1"
BOTTOM_PANE="${SESSION}:${WINDOW_INDEX}.2"
PAGE_ID="${NOTION_DEMO_PAGE_ID:-34af141b18dc80ec8bb3e939c65131b9}"
OPENDEAD_DIR="${OPENDEAD_DIR:-$HOME/OpenDead/notion-video-recordings}"
RUNS_DIR="$OPENDEAD_DIR/runs"
LATEST_DIR="$OPENDEAD_DIR/latest"
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
RUN_NAME="notion-demo-${TIMESTAMP}-full-manual-demo"
OUT_DIR="${1:-$RUNS_DIR/$RUN_NAME}"
FPS="${NOTION_VIDEO_FPS:-4}"
SETTLE_SECONDS="${NOTION_VIDEO_SETTLE_SECONDS:-3}"
WINDOW_BOUNDS_SCRIPT="$PKG_DIR/scripts/manual-video/window-bounds.swift"
SOURCE_FILE="$PKG_DIR/tmp/notion-video-manual-demo.tsx"
TOKEN_FILE="${NOTION_VIDEO_TOKEN_FILE:-/tmp/notion_demo_token}"

mkdir -p "$OUT_DIR"
mkdir -p "$LATEST_DIR"
mkdir -p "$OUT_DIR/frames"
mkdir -p "$OUT_DIR/chapters"
mkdir -p "$OUT_DIR/frames/ghostty"
mkdir -p "$OUT_DIR/frames/chrome"

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "missing token file: $TOKEN_FILE" >&2
  exit 1
fi

mapfile -t CHAPTER_IDS < <(
  cd "$PKG_DIR" &&
    bun src/demo/manual-video/emit-source.ts --list
)

if [[ "${#CHAPTER_IDS[@]}" -eq 0 ]]; then
  echo "no chapters found" >&2
  exit 1
fi

capture_loop() {
  local ghostty_id="$1"
  local chrome_id="$2"
  local ghostty_dir="$3"
  local chrome_dir="$4"
  local fps="$5"

  local index=0
  while true; do
    printf -v ghostty_frame '%s/frame-%04d.png' "$ghostty_dir" "$index"
    printf -v chrome_frame '%s/frame-%04d.png' "$chrome_dir" "$index"
    screencapture -l"$ghostty_id" -x "$ghostty_frame"
    screencapture -l"$chrome_id" -x "$chrome_frame"
    index=$((index + 1))
    sleep "$(awk "BEGIN { printf \"%.3f\", 1 / $fps }")"
  done
}

ghostty_id="$(swift "$WINDOW_BOUNDS_SCRIPT" ghostty-id)"
chrome_id="$(swift "$WINDOW_BOUNDS_SCRIPT" chrome-id)"
capture_loop "$ghostty_id" "$chrome_id" "$OUT_DIR/frames/ghostty" "$OUT_DIR/frames/chrome" "$FPS" &
record_pid=$!

cleanup() {
  if [[ -n "${record_pid:-}" ]] && kill -0 "$record_pid" 2>/dev/null; then
    kill "$record_pid" 2>/dev/null || true
    wait "$record_pid" || true
  fi
}
trap cleanup EXIT

run_started_at="$(date +%s)"
chapter_manifest="$OUT_DIR/chapters/manifest.jsonl"
: >"$chapter_manifest"

for chapter_id in "${CHAPTER_IDS[@]}"; do
  chapter_dir="$OUT_DIR/chapters/$chapter_id"
  mkdir -p "$chapter_dir"

  chapter_started_at="$(date +%s)"

  (
    cd "$PKG_DIR"
    bun src/demo/manual-video/emit-source.ts "$chapter_id" "$SOURCE_FILE"
  ) >"$chapter_dir/emit-source.json"

  tmux send-keys -t "$TOP_PANE" Escape
  tmux send-keys -t "$TOP_PANE" ":silent! checktime" Enter
  tmux send-keys -t "$TOP_PANE" ":edit! $SOURCE_FILE" Enter
  sleep 0.5

  tmux send-keys -t "$BOTTOM_PANE" C-c
  tmux send-keys -t "$BOTTOM_PANE" "clear" Enter
  tmux send-keys -t "$BOTTOM_PANE" \
    "cd '$PKG_DIR'; time env NOTION_TOKEN=(sed -n '\$p' '$TOKEN_FILE') bun tmp/notion-video-manual-demo.tsx '$PAGE_ID'" \
    Enter

  for _ in $(seq 1 45); do
    pane="$(tmux capture-pane -t "$BOTTOM_PANE" -p | tail -n 20)"
    if printf '%s\n' "$pane" | rg -q 'Executed in'; then
      break
    fi
    sleep 1
  done

  sleep "$SETTLE_SECONDS"

  (
    cd "$PKG_DIR"
    env NOTION_TOKEN="$(sed -n '$p' "$TOKEN_FILE")" \
      bun src/demo/manual-video/validate.ts "$chapter_id" "$PAGE_ID" "$chapter_dir"
  ) >"$chapter_dir/validate.json"

  chapter_finished_at="$(date +%s)"
  chapter_start_offset=$((chapter_started_at - run_started_at))
  chapter_end_offset=$((chapter_finished_at - run_started_at))

  printf '{"chapterId":"%s","startSeconds":%s,"endSeconds":%s}\n' \
    "$chapter_id" "$chapter_start_offset" "$chapter_end_offset" >>"$chapter_manifest"
done

sleep 1
cleanup
trap - EXIT

video_file="$OUT_DIR/${RUN_NAME}.mp4"
frame_file="$OUT_DIR/${RUN_NAME}.png"

terminal_frame="$OUT_DIR/terminal-latest.png"
browser_frame="$OUT_DIR/browser-latest.png"
screencapture -l"$ghostty_id" -x "$terminal_frame"
screencapture -l"$chrome_id" -x "$browser_frame"

ffmpeg -hide_banner -loglevel error -y \
  -i "$terminal_frame" \
  -i "$browser_frame" \
  -filter_complex '[0:v][1:v]scale2ref=oh*mdar:ih[left][right];[left][right]hstack=inputs=2' \
  -frames:v 1 \
  "$frame_file"

ffmpeg -hide_banner -loglevel error -y \
  -framerate "$FPS" -i "$OUT_DIR/frames/ghostty/frame-%04d.png" \
  -framerate "$FPS" -i "$OUT_DIR/frames/chrome/frame-%04d.png" \
  -filter_complex '[0:v][1:v]scale2ref=oh*mdar:ih[left][right];[left][right]hstack=inputs=2' \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p "$video_file"

cp "$video_file" "$LATEST_DIR/latest.mp4"
cp "$frame_file" "$LATEST_DIR/latest.png"
ln -sfn "$OUT_DIR" "$LATEST_DIR/current-run"

printf 'video=%s\n' "$video_file"
printf 'frame=%s\n' "$frame_file"
printf 'manifest=%s\n' "$chapter_manifest"
