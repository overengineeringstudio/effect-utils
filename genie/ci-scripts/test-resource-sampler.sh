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
sample_count=0
peak_rss=0
peak_cpu=0
peak_compressor=0
first_pageouts=0
last_pageouts=0
stopping=0
sleeper=''
stop() {
  stopping=1
  if [[ -n "$sleeper" ]]; then kill "$sleeper" 2>/dev/null || :; fi
}
trap stop TERM INT
trap 'rm -f "$output.partial"' EXIT
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
      read -r rss cpu pageouts compressor <<< "$metrics $counters"
      if (( sample_count == 0 )); then first_pageouts=$pageouts; fi
      sample_count=$((sample_count + 1))
      (( rss <= peak_rss )) || peak_rss=$rss
      (( compressor <= peak_compressor )) || peak_compressor=$compressor
      peak_cpu=$(awk -v candidate="$cpu" -v peak="$peak_cpu" 'BEGIN { printf "%.3f", (candidate > peak ? candidate : peak) }')
      last_pageouts=$pageouts
    else
      failures=$((failures + 1))
    fi
  else
    failures=$((failures + 1))
  fi
  # Persist a complete snapshot after each attempt, before any sleep or next
  # native command. Forced group shutdown therefore retains completed samples.
  if (( sample_count > 0 )); then
    compressor_json=null
    if [[ "$platform" == Darwin ]]; then compressor_json=$peak_compressor; fi
    printf '{"schemaVersion":1,"platform":"%s","scope":"host","sampleIntervalSeconds":%d,"sampleCount":%d,"failedSampleCount":%d,"totalMemoryBytes":%s,"peakSummedProcessRssBytes":%s,"peakSummedProcessLifetimeCpuPercent":%s,"peakCompressorBytes":%s,"pageoutsDuringSampling":%d,"rssSemantics":"sum of process RSS; shared pages may be counted repeatedly","cpuSemantics":"sum of ps process lifetime-average percentages; 100 means one CPU","pageoutSemantics":"Darwin Pageouts or Linux pswpout counter delta; units are native pages"}\n' \
      "$platform" "$interval" "$sample_count" "$failures" "$total" "$peak_rss" "$peak_cpu" \
      "$compressor_json" "$((last_pageouts - first_pageouts))" > "$output.partial"
    mv "$output.partial" "$output"
  fi
  (( stopping == 0 )) || break
  sleep "$interval" &
  sleeper=$!
  wait "$sleeper" || :
  wait "$sleeper" 2>/dev/null || :
  sleeper=''
done
# Missing evidence remains missing rather than reporting fabricated zero peaks.
(( sample_count > 0 ))
