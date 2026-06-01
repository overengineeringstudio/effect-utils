# Notion CLI Requirements

## Context

This document defines package-level requirements for `@overeng/notion-cli`. It is constrained by the datasource-sync VRS decisions in [../notion-datasource-sync/docs/vrs/decisions/0008-single-database-cli-surface.md](../../notion-datasource-sync/docs/vrs/decisions/0008-single-database-cli-surface.md) and [../notion-datasource-sync/docs/vrs/decisions/0007-replica-export-replaces-raw-dump.md](../../notion-datasource-sync/docs/vrs/decisions/0007-replica-export-replaces-raw-dump.md).

## Assumptions

- **A01 Effect CLI:** User-facing commands are modeled as Effect CLI command trees.
- **A02 Runtime split:** The packaged `notion` binary is Bun-compiled, while datasource-sync replica execution requires Node 24 because it imports `node:sqlite`.
- **A03 Package ownership:** `@overeng/notion-cli` owns the umbrella command surface; package-specific behavior remains owned by the package that implements it.
- **A04 Generated package metadata:** Package metadata is generated from `package.json.genie.ts`; generated `package.json` files are not edited directly.

## Acceptable Tradeoffs

- **T01 Wrapper dispatch:** The Nix package may use a shell wrapper for selected `notion db` leaves because preserving the Bun root binary and the Node SQLite runtime in one native artifact would couple unrelated runtimes.
- **T02 Import-safe descriptors:** The root CLI may expose commands whose handlers fail closed in source/Bun execution when those commands require a packaged runtime.

## Requirements

### Must Provide One Coherent User Surface

- **R01 Root command:** The public executable name must be `notion`.
- **R02 Command namespaces:** The root command must expose `md`, `schema`, and `db` as the supported first-level namespaces.
- **R03 No legacy aliases:** The root command must not expose `sqlite`, `notion-datasource-sync`, `db dump`, or `db replica` as public compatibility surfaces.
- **R04 Database namespace:** Database metadata, replica sync, status, conflict, repair, and export workflows must live under `notion db`.
- **R05 Markdown namespace:** Markdown page workflows must live under `notion md` and be composed from `@overeng/notion-md`.
- **R06 Schema namespace:** Schema generation, introspection, config generation, and drift detection must live under `notion schema`.

### Must Preserve Runtime Boundaries

- **R07 Import-safe root:** Importing and running root help/completion generation must not import Node-only `node:sqlite` modules into the Bun-compiled root CLI.
- **R08 Packaged replica execution:** Packaged `notion db` replica leaves must execute through the Node-backed datasource-sync runtime.
- **R09 Local metadata execution:** `notion db info` must remain executable in the Bun root CLI because it does not require `node:sqlite`.
- **R10 Source fail-closed:** Source/Bun execution of Node-backed replica leaves must fail closed with an actionable runtime message.

### Must Keep Export And Sync Semantics Clean

- **R11 Replica export:** `notion db export` must be backed by the datasource-sync replica contract, not by a raw Notion dump implementation.
- **R12 Non-mutating export refresh:** `notion db export --from-notion` may establish or refresh the local replica by pull/project-only work, but must not push local changes or mutate Notion.
- **R13 Public status:** `notion db status` and export metadata must use the public replica status contract, including explicit state buckets.

### Must Be Verifiable

- **R14 Help drift tests:** Tests must prove root help/completions expose supported namespaces and exclude retired surfaces.
- **R15 Runtime smoke test:** The Nix package must smoke-test a Node-backed `notion db` leaf.
- **R16 Package gates:** Changes to the CLI surface must pass TypeScript, lint, generated metadata checks, package tests, and a Nix build of `.#notion-cli`.
