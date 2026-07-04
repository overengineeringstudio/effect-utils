# CLI shape: classic triad, JSON-on-stdout, jq-not-query, sysexits codes

otelite's CLI is the triad `run` / `inspect` / `capture` (all v1) with an
agent-first, Unix-composable contract. A design exploration scored this triad
30/30 against a git-style plumbing/porcelain split (25) and a single fused verb
(21). `inspect` covers traces, metrics, and logs at parity (R10).

## Choices

- **stdout = machine JSON only**, stderr = all human output **and the Child's
  stdout** — so `run | jq` and `run | inspect -` are always clean. JSON is the
  default; `--pretty` opt-in (agents are the primary consumer). Every object
  carries a `schema: "name/vN"` tag locked by the conformance goldens.
- **Composition over a mega-verb:** the `run` summary carries `.out`, so
  `otelite run -- cmd | otelite inspect - | jq -e ...` is the one-liner
  capture→assert path. `inspect` reads dir | file | `-`.
- **`jq`, not a query language:** `--service/--name/--attr k=v/--summary` cover
  exact-match; everything else is `| jq`. Borrowed from `rg --json`. Upholds the
  scope line (otelite normalizes, tests assert).
- **Exit codes:** `run` preserves the Child's code; otelite's own failures use
  `sysexits.h` (64 usage, 65 decode, 66 missing source, 73 out-dir, 74 bind/
  write, 75 drain-idle timeout, 70 internal), disambiguated by empty stdout.
- **Isolation ergonomics:** ephemeral `:0` + optional auto-unique `--out` echoed
  in the summary → coordination-free parallel agents (see `0010` once the
  concurrency experiment confirms the default-dir behavior).

## Rejected

- **git plumbing/porcelain split** — premature for a two-verb tool.
- **Single fused `run+assert` verb** — breaks the capture→inspect pipe seam and
  bakes assertion into the tool (a non-goal).
