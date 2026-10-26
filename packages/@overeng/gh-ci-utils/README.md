# gh-ci-utils

## Local GitHub API usage ledger

GitHub HTTP requests append one JSON line to a local usage ledger, including
REST, GraphQL, GitHub App token exchanges, and GitHub web requests. Each row has
`schemaVersion: 1`, a UTC timestamp, source (`gh-ci-utils`), local hostname,
endpoint class (`core`, `graphql`, `search`, or `actions`), HTTP method, templated
route, response status, authentication kind, and CLI subcommand when known.
Rate-limit resource and remaining count are included when supplied by GitHub.
Transport failures have a null status. Tokens, other headers, bodies, and query
strings are never recorded. Only an allowlist of static route segments is kept;
owners, repository names, numeric IDs, refs, SHAs, file paths, and other dynamic
segments are templated. Authentication kind follows the actual token source,
including `gh-cli` when an App-configured client falls back to the local CLI token.

`agent` is `FRACTAL_AGENT`, falling back to `ST_AGENT`, or null if neither is set.
If both variables are set but differ, `agent` is null and `agentConflict: true`
is included rather than silently choosing one identity.

By default, files are written to
`${XDG_STATE_HOME:-~/.local/state}/gh-ci-utils/usage-YYYY-MM-DD.jsonl` using UTC
dates. Daily files older than fourteen days are removed opportunistically, at
most once per process. Set `GH_CI_UTILS_USAGE_LEDGER` to an **alternative own file
path** to override this location. That file is not rotated or pruned; its owner
manages retention.

Writes are asynchronous, serialized, append-only, and best-effort: filesystem
failures do not fail requests, and produce at most one warning per process.
Each row uses one append-mode write, allowing independent processes to append
without interleaving rows. Existing targets must be regular files; FIFOs, devices,
directories, and symlinks are refused. Orderly CLI shutdown allows up to two
seconds to drain queued writes, then drops remaining rows with the same
one-per-process warning rather than blocking exit indefinitely.
