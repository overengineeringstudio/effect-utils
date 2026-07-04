# Experiment 0004 — nix --log-format internal-json source

**Method:** Determinate Nix 3.17.3 (nix 2.33.3). Trivial `nix eval` and one
trivial derivation under an out-of-repo tmp dir, `--log-format internal-json`.
Also inspected the `nix:check:quick` task wiring.

**Result:**

- The `@nix {json}` NDJSON stream is on **stderr**; the command result stays on
  **stdout** → side-channel, no re-render needed.
- `action` ∈ {start, stop, result, msg}. start/stop pairs carry `id` + a `type`
  = Nix `ActivityType` (105 build, 108 substitute, 100 copyPath, 101
  fileTransfer, 109 queryPathInfo). `result` lines are progress counters.
- Signal-to-noise on a trivial build: 17 start + 17 stop (only 1 real build) vs
  138 `result` progress lines. Trivial `nix eval` emits an **empty** stream.

```
@nix {"action":"start","id":<id>,"type":109,"fields":["/nix/store/<hash>-<name>","<cache>"],...}
@nix {"action":"result","id":<id2>,"type":105,"fields":[0,0,0,0]}   # progress — DROP
@nix {"action":"start","id":<id3>,"type":105,"fields":["/nix/store/<hash>-<name>.drv","",1,1],...}  # build — SPAN
@nix {"action":"stop","id":<id3>}
```

- Premise correction: `nix:check:quick:*` forks `nix-hash` (~20ms) via a shell
  script, not `nix` — no adapter surface, and duration is already task-span
  timed.

**Conclusion:** build-lane adapter-worthwhile (spans from start/stop, drop all
progress). Not a `check:quick` deliverable. internal-json is de-facto (consumed
by nix-output-monitor), not a versioned public schema → R08-stability DQ.
