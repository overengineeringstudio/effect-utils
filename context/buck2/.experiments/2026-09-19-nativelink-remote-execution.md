# NativeLink action-level remote execution on dev4

Date: 2026-09-19
Target revision: `948d397a2e09a3dc8556535eee5bb083717d3630` (`schickling-assistant/2026-09-15-quick-aggregate`)
Host: dev4 (`aarch64-linux`, 30 GiB RAM)

## Question

Can a fresh NativeLink CAS, action cache, scheduler, and one aarch64 worker execute
real `//:quick` graph actions remotely when Buck local execution is disabled, then
execute changed actions again and serve unchanged actions from the action cache?

## Method

1. Wait for dev4 after its incident #2914 reboot; use only an isolated clone and
   `/srv/bulk/coding-agents/tmp/nativelink` or `/tmp` state.
2. Prefer `nixpkgs#nativelink`; when absent, realize NativeLink from its flake.
3. Apply the fixture patch, which adds an opt-in remote-only
   `exec_linux_aarch64_remote` platform and relaxes the graph's explicit
   `local_only = True` only when the experiment buckconfig enables RE. This was
   necessary for `package_tree`, the three pnpm-store assembly classes,
   `tsgo_typecheck`, `tsgo_emit`, Vitest collection, and the test executor.
4. Run one localhost NativeLink process with a verified filesystem CAS, filesystem
   AC, scheduler, and one exactly-matched worker. Realize `.#buck2-capabilities`
   on the same host and expose its complete `/nix/store` closure to the worker.
5. With a fresh service and fresh `buck-out`, run the content-address package's
   typecheck, emit, and unit test plus `//:quick`; append a source comment and run
   the three actions again; wipe only Buck local state and repeat unchanged.
   Retain timings, NativeLink execution lines, and `buck2 log what-ran` per step.
6. Stop before action execution if obtaining NativeLink threatens the shared host.

The action proof did not run: step 2 could not safely complete. The current
NativeLink flake (`45a3b1b`, Cargo version 1.7.1) failed on aarch64 while building
LLVM compiler-rt 22.1.8: `cpu_model/aarch64.c:51:10: fatal error:
'sys/auxv.h' file not found`. A retry with pinned NativeLink 1.6.6
flake (`a21edb0f`) reached 1,819 build-log lines, requested 38,201,159,680 bytes of
auto-GC, and coincided with a separate dev4 NixOS CI build. The host reached 99%
root-disk use, about 1.0 GiB MemAvailable, 7.8/8.0 GiB swap, and memory PSI
`full avg60=58.80`; the retry was terminated before another reboot.

## Fixtures

- `2026-09-19-nativelink-remote-execution/nativelink.json5`: one 1 GiB verified
  CAS (`verify_size` + `verify_hash`), 128 MiB AC, 1 GiB worker fast tier,
  scheduler, worker, and localhost ports 51051/51061.
- `2026-09-19-nativelink-remote-execution/buckconfig.local`: all three REAPI
  addresses, no TLS, isolated instance name, and remote-only platform selection.
- `2026-09-19-nativelink-remote-execution/remote-execution.patch`: opt-in platform
  properties `platform=exec_linux_aarch64_remote`, `OSFamily=linux`, and
  `cpu_arch=aarch64`, with defaults unchanged when the experiment config is absent.
- `2026-09-19-nativelink-remote-execution/run-dev4.sh`: acquisition, clean-state
  matrix, evidence capture, source restoration, process stop, and state teardown.
- Buck documents the required client addresses and `CommandExecutorConfig`
  fields at <https://buck2.build/docs/users/remote_execution/>. The NativeLink
  all-in-one topology follows
  <https://github.com/TraceMachina/nativelink/blob/a21edb0fc56879124e308bb9a67be679f8eaf885/nativelink-config/examples/local_rbe_self_test.json5>.

## Result

| Action                                         | Fresh CAS: miss -> remote      | Source changed -> remote | Unchanged + fresh Buck state -> AC hit |
| ---------------------------------------------- | ------------------------------ | ------------------------ | -------------------------------------- |
| `tsgo_typecheck` (`content-address:typecheck`) | NOT RUN: NativeLink unrealized | NOT RUN                  | NOT RUN                                |
| `tsgo_emit` (`content-address:dist`)           | NOT RUN: NativeLink unrealized | NOT RUN                  | NOT RUN                                |
| unit test (`content-address:test`)             | NOT RUN: NativeLink unrealized | NOT RUN                  | NOT RUN                                |

`//:quick` was also not invoked. There are no NativeLink worker logs, execution
metrics, or `buck2 log what-ran` claims to interpret as execution evidence.
Action-level RE is therefore **not proven or falsified**; the acquisition and
host-capacity prerequisites are falsified for this dev4 run.

## Timing

| Step                               | Wall time | Result                                 |
| ---------------------------------- | --------: | -------------------------------------- |
| Wait for dev4 recovery             |   23m 59s | five-minute probe 5 succeeded          |
| NativeLink 1.7.1 flake realization | about 10m | deterministic compiler-rt failure      |
| NativeLink 1.6.6 flake retry       |   11m 13s | stopped at shared-host safety boundary |
| Buck action matrix                 |        0s | not reached                            |

## What broke

- nixpkgs on dev4 did not expose `nativelink`; the required flake path was not a
  practical aarch64 acquisition path in this run. The latest pin failed; the
  older pin's large uncached closure exhausted the remaining safe host envelope.
- The real graph is not platform-toggle-ready: execution platforms disable RE
  (`buck2/platforms/defs.bzl:147-152`), TypeScript actions set `local_only`
  (`buck2/typescript.bzl:49-55,103-109`), and tests install their own local-only
  executor (`buck2/javascript.bzl:120-143`). The fixture patch also covers the
  local-only pnpm/package-tree prerequisites identified by the 2026-09-18 run.
- Same-host workers can read the already-realized absolute `/nix/store` paths.
  A different worker host would require the exact `nix path-info -r` closure to
  be copied/substituted there before registration; REAPI input upload does not
  transport those ambient absolute paths.
- No action ran, so HOME, pnpm-store, hostname assumptions and output-digest
  equality against dev3's bazel-remote AC were not tested. Platform properties
  also intentionally change the action identity, so AC keys are not directly
  comparable; output bytes would need comparison after successful execution.
- The fixture deliberately has localhost-only plaintext gRPC and no auth. It is
  an execution proof fixture, not an acceptable network deployment boundary.
- Teardown restored the clone, removed config/capability links and all experiment
  state, removed the clone, and left neither process nor listener on 51051/51061.

## Falsifiers

- Feasibility remains open until a substituted/packageable aarch64 NativeLink
  starts without violating dev4's disk and memory envelope.
- Any representative row with a local command, no worker `Executing command`, or
  no remote line in `what-ran` falsifies remote-only execution.
- A changed input served as an AC hit, or an unchanged run executing again after
  local-state wipe, falsifies the expected key/cache behavior.
- A missing `/nix/store` executable on the worker falsifies same-host capability
  visibility; differing output bytes falsify cross-backend reproducibility.

## Conclusion

The experiment establishes a prepared action-level RE probe but no execution
verdict. NativeLink acquisition on aarch64 and safe dev4 capacity are blocking
prerequisites; no cache or execution result is claimed.

## VRS Impact

No requirement or decision changes. This evidence records an unresolved
execution proof and preserves the exact rerunnable fixture.
