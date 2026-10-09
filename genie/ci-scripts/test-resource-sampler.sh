#!/usr/bin/env bash
# Host-wide diagnostic evidence only: never changes the test command's verdict.
set -euo pipefail
output=${1:?JSON output path required}
interval=5
platform=$(uname -s)
case "$platform" in
  Darwin) total=$(sysctl -n hw.memsize) ;;
  Linux) total=$(awk '$1 == "MemTotal:" { printf "%.0f", $2 * 1024 }' /proc/meminfo) ;;
  *) echo "resource sampler: unsupported platform $platform" >&2; exit 1 ;;
esac
[[ "$total" =~ ^[0-9]+$ ]] && (( total > 0 ))
mkdir -p "$(dirname "$output")"
samples=$(mktemp)
stopping=0
sleeper=''
stop() {
  stopping=1
  if [[ -n "$sleeper" ]]; then kill "$sleeper" 2>/dev/null || :; fi
}
trap stop TERM INT
trap 'rm -f "$samples"' EXIT
failures=0
while (( stopping == 0 )); do
  # ps %cpu is each process's lifetime-average CPU percentage, not an interval
  # utilization reading. Sum RSS includes shared pages more than once.
  if processes=$(ps -axo rss=,%cpu=) && metrics=$(printf '%s\n' "$processes" | awk '
    NF == 2 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+([.][0-9]+)?$/ { rss += $1 * 1024; cpu += $2; count++ }
    END { if (!count) exit 1; printf "%.0f %.3f", rss, cpu }'); then
    if [[ "$platform" == Darwin ]]; then
      # Native VM counters contextualize RSS without calling low free memory
      # pressure. Pageouts are cumulative since host boot.
      vm=$(vm_stat) || vm=''
      counters=$(printf '%s\n' "$vm" | awk '
        /page size of/ { for (i=1;i<NF;i++) if ($i == "of") page=$(i+1) }
        /^Pages occupied by compressor:/ { value=$NF; sub(/[.]$/, "", value); compressor=value }
        /^Pageouts:/ { value=$NF; sub(/[.]$/, "", value); pageouts=value; found=1 }
        END { if (!page || !found) exit 1; printf "%.0f %.0f", pageouts, compressor * page }') || counters=''
    else
      counters=$(awk '$1 == "pswpout" { printf "%.0f 0", $2; found=1 } END { if (!found) exit 1 }' /proc/vmstat) || counters=''
    fi
    if [[ -n "$counters" ]]; then
      printf '%s %s\n' "$metrics" "$counters" >> "$samples"
    else
      failures=$((failures + 1))
    fi
  else
    failures=$((failures + 1))
  fi
  (( stopping == 0 )) || break
  sleep "$interval" &
  sleeper=$!
  wait "$sleeper" || :
  wait "$sleeper" 2>/dev/null || :
  sleeper=''
done
# Missing evidence remains missing rather than reporting fabricated zero peaks.
report=$(awk -v platform="$platform" -v total="$total" -v interval="$interval" -v failures="$failures" '
  NF == 4 {
    if (!count) firstPageouts=$3
    if ($1 > rss) rss=$1
    if ($2 > cpu) cpu=$2
    if ($4 > compressor) compressor=$4
    lastPageouts=$3
    count++
  }
  END {
    if (!count) exit 1
    compressorJson = platform == "Darwin" ? sprintf("%.0f", compressor) : "null"
    printf "{\"schemaVersion\":1,\"platform\":\"%s\",\"scope\":\"host\",\"sampleIntervalSeconds\":%d,\"sampleCount\":%d,\"failedSampleCount\":%d,\"totalMemoryBytes\":%.0f,\"peakSummedProcessRssBytes\":%.0f,\"peakSummedProcessLifetimeCpuPercent\":%.3f,\"peakCompressorBytes\":%s,\"pageoutsDuringSampling\":%.0f,\"rssSemantics\":\"sum of process RSS; shared pages may be counted repeatedly\",\"cpuSemantics\":\"sum of ps process lifetime-average percentages; 100 means one CPU\",\"pageoutSemantics\":\"Darwin Pageouts or Linux pswpout counter delta; units are native pages\"}\n", platform, interval, count, failures, total, rss, cpu, compressorJson, lastPageouts-firstPageouts
  }
' "$samples")
printf '%s\n' "$report" > "$output"
