#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../../../.." && pwd)"
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
TARGET_VIDEO_FPS="${NOTION_VIDEO_TARGET_FPS:-30}"
VALIDATE_TIMEOUT_SECONDS="${NOTION_VIDEO_VALIDATE_TIMEOUT_SECONDS:-2.5}"
VALIDATE_POLL_INTERVAL_SECONDS="${NOTION_VIDEO_VALIDATE_POLL_INTERVAL_SECONDS:-0.35}"
MAX_VALIDATE_ATTEMPTS="${NOTION_VIDEO_MAX_VALIDATE_ATTEMPTS:-3}"
RETRY_DELAY_SECONDS="${NOTION_VIDEO_RETRY_DELAY_SECONDS:-0.75}"
VIDEO_BAND_HEIGHT="${NOTION_VIDEO_BAND_HEIGHT:-220}"
SYNC_TIMEOUT_SECONDS="${NOTION_VIDEO_SYNC_TIMEOUT_SECONDS:-75}"
WINDOW_BOUNDS_SCRIPT="$PKG_DIR/scripts/manual-video/window-bounds.swift"
SOURCE_FILE="$PKG_DIR/tmp/notion-video-manual-demo.tsx"
TOKEN_FILE="${NOTION_VIDEO_TOKEN_FILE:-/tmp/notion_demo_token}"
GHOSTTY_PID="${NOTION_VIDEO_GHOSTTY_PID:-}"
CHROME_PID="${NOTION_VIDEO_CHROME_PID:-}"

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

if [[ -z "$GHOSTTY_PID" ]]; then
  GHOSTTY_PID="$(swift "$WINDOW_BOUNDS_SCRIPT" ghostty-pid)"
fi

if [[ -z "$CHROME_PID" ]]; then
  CHROME_PID="$(swift "$WINDOW_BOUNDS_SCRIPT" chrome-pid)"
fi

export NOTION_VIDEO_GHOSTTY_PID="$GHOSTTY_PID"
export NOTION_VIDEO_CHROME_PID="$CHROME_PID"

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

now_seconds() {
  python3 -c 'import time; print(f"{time.time():.3f}")'
}

seconds_diff() {
  local start="$1"
  local end="$2"
  awk "BEGIN { printf \"%.3f\", $end - $start }"
}

run_sync() {
  tmux send-keys -t "$TOP_PANE" Escape
  tmux send-keys -t "$TOP_PANE" ":silent update" Enter
  sleep 0.2

  tmux send-keys -t "$BOTTOM_PANE" C-c
  tmux send-keys -t "$BOTTOM_PANE" "clear" Enter
  tmux send-keys -t "$BOTTOM_PANE" \
    "cd '$PKG_DIR'; env NOTION_TOKEN=(sed -n '\$p' '$TOKEN_FILE') bun src/demo/manual-video/run-sync.ts '$PAGE_ID'" \
    Enter

  local max_polls
  max_polls="$(awk "BEGIN { printf \"%d\", ($SYNC_TIMEOUT_SECONDS / 0.25) + 0.5 }")"

  for _ in $(seq 1 "$max_polls"); do
    pane="$(tmux capture-pane -t "$BOTTOM_PANE" -p | tail -n 20)"
    if printf '%s\n' "$pane" | rg -q 'SYNC OK'; then
      return 0
    fi
    sleep 0.25
  done

  echo "sync runner did not print a success summary in the lower tmux pane" >&2
  return 1
}

reload_top_pane_source() {
  tmux send-keys -t "$TOP_PANE" Escape
  tmux send-keys -t "$TOP_PANE" ":silent! checktime" Enter
  tmux send-keys -t "$TOP_PANE" ":edit! $SOURCE_FILE" Enter
  sleep 0.2
}

reset_top_pane_editor() {
  tmux send-keys -t "$TOP_PANE" Escape
  tmux send-keys -t "$TOP_PANE" ":qa!" Enter
  sleep 0.3
  tmux send-keys -t "$TOP_PANE" C-c
  tmux send-keys -t "$TOP_PANE" "cd '$PKG_DIR'" Enter
  tmux send-keys -t "$TOP_PANE" "nvim '$SOURCE_FILE'" Enter
  sleep 1
}

validate_chapter() {
  local chapter_id="$1"
  local attempt_dir="$2"

  (
    cd "$PKG_DIR"
    env NOTION_TOKEN="$(sed -n '$p' "$TOKEN_FILE")" \
      bun src/demo/manual-video/validate.ts "$chapter_id" "$PAGE_ID" "$attempt_dir"
  ) >"$attempt_dir/validate.json" 2>"$attempt_dir/validate.stderr"
}

wait_for_validation() {
  local chapter_id="$1"
  local attempt_dir="$2"
  local started_at current_at elapsed_seconds

  started_at="$(now_seconds)"

  while true; do
    if validate_chapter "$chapter_id" "$attempt_dir"; then
      return 0
    fi

    current_at="$(now_seconds)"
    elapsed_seconds="$(seconds_diff "$started_at" "$current_at")"
    if awk "BEGIN { exit !($elapsed_seconds >= $VALIDATE_TIMEOUT_SECONDS) }"; then
      break
    fi

    sleep "$VALIDATE_POLL_INTERVAL_SECONDS"
  done

  return 1
}

emit_chapter_source() {
  local chapter_id="$1"
  local output_file="$2"

  (
    cd "$PKG_DIR"
    bun src/demo/manual-video/emit-source.ts "$chapter_id" "$output_file"
  )
}

perform_editor_transition() {
  local from_chapter_id="$1"
  local to_chapter_id="$2"
  local output_file="$3"

  (
    cd "$PKG_DIR"
    bun src/demo/manual-video/perform-transition.ts \
      "$from_chapter_id" \
      "$to_chapter_id" \
      "$TOP_PANE"
  ) >"$output_file"
}

prestage_empty_page() {
  local chapter_id="chapter-0-empty-page"
  local prestage_dir="$OUT_DIR/prestage-empty"
  mkdir -p "$prestage_dir"

  emit_chapter_source "$chapter_id" "$SOURCE_FILE" >"$prestage_dir/emit-source.json"
  reset_top_pane_editor
  run_sync >"$prestage_dir/sync.log" 2>&1 || {
    cat "$prestage_dir/sync.log" >&2
    return 1
  }

  if ! wait_for_validation "$chapter_id" "$prestage_dir"; then
    cat "$prestage_dir/validate.stderr" >&2 || true
    return 1
  fi
}

prestage_empty_page

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

run_started_at="$(now_seconds)"
chapter_manifest="$OUT_DIR/chapters/manifest.jsonl"
: >"$chapter_manifest"
previous_chapter_id="chapter-0-empty-page"

for chapter_id in "${CHAPTER_IDS[@]}"; do
  chapter_dir="$OUT_DIR/chapters/$chapter_id"
  mkdir -p "$chapter_dir"
  mkdir -p "$chapter_dir/attempts"

  chapter_started_at="$(now_seconds)"

  emit_chapter_source "$chapter_id" "$chapter_dir/expected-source.tsx" \
    >"$chapter_dir/emit-source.json"
  perform_editor_transition "$previous_chapter_id" "$chapter_id" \
    "$chapter_dir/editor-transition.json"

  attempt_used=0
  for attempt in $(seq 1 "$MAX_VALIDATE_ATTEMPTS"); do
    attempt_dir="$chapter_dir/attempts/attempt-$attempt"
    mkdir -p "$attempt_dir"

    run_sync

    if wait_for_validation "$chapter_id" "$attempt_dir"; then
      attempt_used="$attempt"
      find "$attempt_dir" -maxdepth 1 -type f -exec cp {} "$chapter_dir"/ \;
      break
    fi

    if [[ "$attempt" -lt "$MAX_VALIDATE_ATTEMPTS" ]]; then
      sleep "$RETRY_DELAY_SECONDS"
    fi
  done

  if [[ "$attempt_used" -eq 0 ]]; then
    echo "chapter validation failed after $MAX_VALIDATE_ATTEMPTS attempts: $chapter_id" >&2
    exit 1
  fi

  printf '{\n  "chapterId": "%s",\n  "attemptsUsed": %s,\n  "maxAttempts": %s,\n  "validateTimeoutSeconds": %s,\n  "validatePollIntervalSeconds": %s,\n  "retryDelaySeconds": %s\n}\n' \
    "$chapter_id" \
    "$attempt_used" \
    "$MAX_VALIDATE_ATTEMPTS" \
    "$VALIDATE_TIMEOUT_SECONDS" \
    "$VALIDATE_POLL_INTERVAL_SECONDS" \
    "$RETRY_DELAY_SECONDS" >"$chapter_dir/attempt-summary.json"

  chapter_finished_at="$(now_seconds)"
  chapter_start_offset="$(seconds_diff "$run_started_at" "$chapter_started_at")"
  chapter_end_offset="$(seconds_diff "$run_started_at" "$chapter_finished_at")"

  printf '{"chapterId":"%s","startSeconds":%s,"endSeconds":%s}\n' \
    "$chapter_id" "$chapter_start_offset" "$chapter_end_offset" >>"$chapter_manifest"
  previous_chapter_id="$chapter_id"
done

cleanup
trap - EXIT

video_file="$OUT_DIR/${RUN_NAME}.mp4"
raw_video_file="$OUT_DIR/${RUN_NAME}.raw.mp4"
frame_file="$OUT_DIR/${RUN_NAME}.png"
overlay_file="$OUT_DIR/chapters/chapter-overlays.ass"
capture_frame_count="$(find "$OUT_DIR/frames/ghostty" -name 'frame-*.png' | wc -l | tr -d ' ')"
run_duration_seconds="$(tail -n 1 "$chapter_manifest" | sed -E 's/.*"endSeconds":([0-9.]+).*/\1/')"

if [[ -z "$run_duration_seconds" ]] || ! awk "BEGIN { exit !($run_duration_seconds > 0) }"; then
  echo "invalid run duration derived from $chapter_manifest" >&2
  exit 1
fi

if [[ -z "$capture_frame_count" || "$capture_frame_count" -le 1 ]]; then
  echo "insufficient frame count captured: $capture_frame_count" >&2
  exit 1
fi

capture_input_fps="$(awk "BEGIN { printf \"%.6f\", $capture_frame_count / $run_duration_seconds }")"

terminal_frame="$OUT_DIR/terminal-latest.png"
browser_frame="$OUT_DIR/browser-latest.png"
screencapture -l"$ghostty_id" -x "$terminal_frame"
screencapture -l"$chrome_id" -x "$browser_frame"

ffmpeg -hide_banner -loglevel error -y \
  -i "$terminal_frame" \
  -i "$browser_frame" \
  -filter_complex "[0:v][1:v]scale2ref=oh*mdar:ih[left][right];[left][right]hstack=inputs=2[stacked];[stacked]pad=iw:ih+${VIDEO_BAND_HEIGHT}:0:0:color=#05070D[padded];[padded]drawbox=x=0:y=ih-${VIDEO_BAND_HEIGHT}:w=iw:h=${VIDEO_BAND_HEIGHT}:color=#10141C@1:t=fill[banded];[banded]drawbox=x=0:y=ih-${VIDEO_BAND_HEIGHT}:w=iw:h=2:color=#263143@1:t=fill" \
  -frames:v 1 \
  "$frame_file"

ffmpeg -hide_banner -loglevel error -y \
  -framerate "$capture_input_fps" -i "$OUT_DIR/frames/ghostty/frame-%04d.png" \
  -framerate "$capture_input_fps" -i "$OUT_DIR/frames/chrome/frame-%04d.png" \
  -filter_complex "[0:v][1:v]scale2ref=oh*mdar:ih[left][right];[left][right]hstack=inputs=2[stacked];[stacked]pad=iw:ih+${VIDEO_BAND_HEIGHT}:0:0:color=#05070D[padded];[padded]drawbox=x=0:y=ih-${VIDEO_BAND_HEIGHT}:w=iw:h=${VIDEO_BAND_HEIGHT}:color=#10141C@1:t=fill[banded];[banded]drawbox=x=0:y=ih-${VIDEO_BAND_HEIGHT}:w=iw:h=2:color=#263143@1:t=fill" \
  -r "$TARGET_VIDEO_FPS" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p "$video_file"

(
  cd "$PKG_DIR"
  bun src/demo/manual-video/render-overlays.ts "$chapter_manifest" "$overlay_file"
) >"$OUT_DIR/chapters/render-overlays.json"

mv "$video_file" "$raw_video_file"
ffmpeg -hide_banner -loglevel error -y \
  -i "$raw_video_file" \
  -vf "ass=$overlay_file" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  -an \
  "$video_file"

cp "$video_file" "$LATEST_DIR/latest.mp4"
cp "$frame_file" "$LATEST_DIR/latest.png"
ln -sfn "$OUT_DIR" "$LATEST_DIR/current-run"

printf 'video=%s\n' "$video_file"
printf 'raw_video=%s\n' "$raw_video_file"
printf 'frame=%s\n' "$frame_file"
printf 'manifest=%s\n' "$chapter_manifest"
printf 'capture_input_fps=%s\n' "$capture_input_fps"
