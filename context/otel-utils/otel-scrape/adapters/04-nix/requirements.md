# Requirements: nix adapter (build lane)

Role: a phase-lane adapter for the Nix build path. This leaf states only
nix-specific testable constraints; inherited rules are not restated.

## Context

- Builds on [../requirements.md](../requirements.md) (fleet) and the parent
  contract [../../requirements.md](../../requirements.md).
- Source evidence: [../.experiments/0004-nix-internal-json.md](../.experiments/0004-nix-internal-json.md).

## Requirements

- **ADP.NIX-R01 Build lane only** (refines ADP-R01): the adapter targets the Nix
  build path (`nix:build`/`nix:flake:check`). The `nix:check:quick:*` tasks fork
  `nix-hash` via a shell script, not `nix`, and get no adapter — their duration
  is already task-span timed.
- **ADP.NIX-R02 Spans from lifecycle only** (refines ADP-R03): spans derive only
  from `start`/`stop` activity pairs (build/substitute/copyPath/fileTransfer);
  every `action:"result"` progress line is dropped.
- **ADP.NIX-R03 Whole-identity hashing** (refines parent R27): store and drv
  paths are hashed in full including the `<name>` suffix (a private-package leak
  vector), not just the `/nix/store/HASH` prefix; substituter hostnames are
  dropped.
- **ADP.NIX-R04 Side-channel, no re-render** (refines parent R30): the adapter
  consumes the stderr/`json-log-path` side-channel while the command result
  stays on stdout untouched, so it owes no re-presentation.
