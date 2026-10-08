#!/usr/bin/env python3
"""Reduce sanitized retained aggregates, not raw Buck events (stdlib only)."""
import json
from pathlib import Path
import sys

source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name('fair-measurements.json')
data = json.loads(source.read_text())
rows = data['rows']
mean = sum(rows[n]['wall_s'] for n in ('L-cold-1', 'L-cold-2')) / 2
print(f'Local mean: {mean:.4f} s')
print('Row\twall_s\tlocal/remote/cached\tRE/client command peaks\tupload/RE download bytes')
for name, row in rows.items():
    actions = '/'.join(str(row['actions'][k]) for k in ('local', 'remote', 'cached'))
    peaks = row['peak_spans']
    print(f"{name}\t{row['wall_s']:.3f}\t{actions}\t{peaks.get('Re/Execute', 0)}/{peaks.get('remote_server_execution', 0)}\t{row['uploaded_blob_bytes']}/{row['download_bytes']['re_download_bytes']}")
for name in ('R-cold', 'R-warm-workers'):
    row = rows[name]
    tiny = sum(row['categories'][c]['execution_sum_s'] for c in ('pnpm_extract', 'pnpm_store_entry'))
    print(f"{name}: {row['wall_s'] / mean:.3f}x local; queue sum {row['remote']['queue_sum_s']:.3f} s; command sum {row['remote']['execution_sum_s']:.3f} s; extract/store command sum {tiny:.3f} s")
print('Parallel sums overlap; do not add them to infer wall time. AC-hit historical execution metadata is excluded.')
