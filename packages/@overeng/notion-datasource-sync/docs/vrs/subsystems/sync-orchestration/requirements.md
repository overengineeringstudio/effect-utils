# Sync Orchestration Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **SYNC-R01 Preflight reread:** Remote writes must re-read the current remote surface and schema before applying when the command can conflict or destroy data.
- **SYNC-R02 Read-after-write:** Successful remote writes must be verified by a fresh read and canonical hash comparison before settlement.
