# Native buck log show JSON: data.proto SpanEndEvent.file_watcher (58),
# FileWatcherEnd.stats, FileWatcherStats.events (6) / fresh_instance (1).
# Watchman fresh-instance updates rehash inputs without enumerating every path.
any(.[];
  .Event.data.SpanEnd.data.FileWatcher.stats? as $stats |
  any($stats.events[]?; .path == "capabilities//defs.bzl") or
  ($watcher == "watchman" and $stats.fresh_instance == true)
)
