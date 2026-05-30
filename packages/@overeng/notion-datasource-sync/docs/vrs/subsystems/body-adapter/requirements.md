# Body Adapter Requirements

Sub-system slice of [the top-level requirements](../../requirements.md). Serves [vision.md](../../vision.md).

## Requirements

- **BODY-R01 Body adapter boundary (was R02):** Page bodies must sync through a `PageBodySyncPort` so `@overeng/notion-md` can be used without datasource-sync owning body internals.
- **BODY-R02 Adapter independence (was R55):** Alternative body adapters or local storage adapters must be possible without changing the sync planner.
