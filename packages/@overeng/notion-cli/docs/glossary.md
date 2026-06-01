# Notion CLI — Glossary

Domain language for the `@overeng/notion-cli` package. This glossary covers the umbrella CLI and runtime boundary, not datasource-sync replica internals.

## Language

**Umbrella CLI**:
The public `notion` executable that composes package-owned command trees under one root.
_Avoid_: monolithic CLI

**Namespace**:
A first-level command group under `notion`, currently `md`, `schema`, or `db`.
_Avoid_: alias, mode

**Native Leaf**:
A command implemented directly inside the Bun-compatible root CLI, such as `notion db info`.
_Avoid_: local command

**Node-backed Leaf**:
A `notion db` command that must execute in the packaged Node runtime because datasource-sync imports `node:sqlite`.
_Avoid_: sqlite command, replica namespace

**Import-safe Descriptor**:
An Effect CLI command tree that can be imported by the Bun root CLI for help and completions without importing Node-only runtime modules.
_Avoid_: stub command, alias

**Wrapper Dispatch**:
The Nix package shell wrapper logic that routes selected `notion db` leaves from the Bun binary to the Node-backed datasource-sync runtime.
_Avoid_: compatibility alias
