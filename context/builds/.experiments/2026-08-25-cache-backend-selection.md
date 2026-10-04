# Shared cache backend selection: bazel-remote vs NativeLink

Date: 2026-08-25
Host class: x86_64-linux development host (dev3)

## Question

Which self-hosted REAPI cache backend should carry cache-only (AC+CAS, no
remote execution) reuse for the pinned Buck2 (`2026-04-14-7600cb80`), and what
client wiring does Buck2 actually require?

## Method

- Both backends ran locally (localhost, high ports, capped disk) and served the
  same disposable probe project through the same pinned Buck2.
- The decisive test wiped all local state (`buck2 kill` + `rm -rf buck-out`)
  before rebuilding, and repeated the build from a second copy of the project
  simulating a second worktree.
- A 20 MB output artifact exercised the ByteStream path on both backends.
- Deployment claims were established with `nix build --dry-run` against the
  fleet's pinned nixpkgs, not from documentation.

## Result

| Probe                                           | bazel-remote 2.6.1                             | NativeLink v1.6.6                                   |
| ----------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Cold rebuild after wiped local state            | Cache hits: 100% (cached: 2)                   | Cache hits: 100% (cached: 2)                        |
| Second project copy (simulated second worktree) | 100% hits                                      | 100% hits                                           |
| Warm no-op build overhead vs local-only         | none (~0.02 s)                                 | none (~0.02 s)                                      |
| 20 MB artifact cold cache-hit rebuild           | 2.35 s incl. daemon start                      | 2.35 s incl. daemon start                           |
| Service RSS after tests                         | 53 MB                                          | 31 MB                                               |
| 20 MB artifact at rest                          | 3.1 MB (zstd, mandatory LRU `--max_size`)      | 21 MB (uncompressed; eviction cap optional)         |
| Nix deployment (`--dry-run`, pinned nixpkgs)    | 8.7 MiB substitute from cache.nixos.org        | 880 derivations built from source, 0 substitutable  |
| Upstream binary cache / NixOS module            | cache.nixos.org / none (custom ~15-line unit)  | none documented / `nixosModules` output is empty    |
| License / cadence                               | Apache-2.0; v2.6.2 2026-07-23, commits 2026-08 | FSL-1.1-Apache-2.0; weekly-ish, config-schema churn |
| Minimal config                                  | 3–5 flags                                      | ~50-line JSON5 stores/services graph                |

Client wiring proven identical for both backends:

- `[buck2_re_client]` `engine_address` / `action_cache_address` / `cas_address`
  all at one `grpc://` endpoint, `instance_name`, `tls = false`. The section
  must live in a buckconfig file (`.buckconfig.local` works); `-c
buck2_re_client.*` CLI overrides never reach the RE client and fail with
  "Error creating Capabilities client: No address".
- Executor: `CommandExecutorConfig(local_enabled = True, remote_enabled =
False, remote_cache_enabled = True, allow_cache_uploads = True)`.
- Uploads additionally require `[buck2] default_allow_cache_upload = true`;
  without it builds succeed but the cache stays empty.
- Digests: the pinned Buck2 already produces SHA256 action digests with
  `digest_algorithms` unset; pin `[buck2] digest_algorithms = SHA256` for
  explicitness. Keep the advertised gRPC batch size below Buck2's 4 MiB tonic
  client limit (facebook/buck2#583).
- An unreachable or misconfigured cache is a hard failure: ~45 s of retries,
  then the action fails at `remote_action_cache`. No soft-degrade to local
  exists in this version.

## Conclusion

Protocol behavior tied; operations decided. bazel-remote, cache-only, on dev3
(recorded in decision 0013; infra issue dotfiles#2009). NativeLink remains the
designated candidate if remote execution enters scope; CAS state is disposable,
so a later swap costs three address lines and one cold cache.

## VRS Impact

Grounds [decision 0013](../.decisions/0013-shared-cache-foundation.md) and the
[04-reuse](../04-reuse/requirements.md) client contract (REUSE-R01, REUSE-R04,
REUSE-R05): backend choice, buckconfig-file wiring, SHA256 pinning, upload
enablement, hard-failure outage posture, and the batch-size limit.
