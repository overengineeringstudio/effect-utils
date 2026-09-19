# Execution Open Questions

## Open 2026-09-19: how is the worker image realized and advertised?

BUCK-R17 requires a worker to hold the exact Nix closure an action's tools come from. Undecided: whether workers share the host Nix store (same-host or `nix copy` of the closure before scheduling), how the closure identity becomes a platform property the scheduler matches, and how Darwin actions (EXEC-R05) are placed. Blocked on: the NativeLink phase's first experiment (the #1317 kit could not start on aarch64; an x86_64 worker host with free memory is needed).
