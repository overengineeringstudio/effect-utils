# Buck2 Dependency-Closure Evidence

This VRS node is the dependency-materialization refinement consumed by the
canonical [`context/buck2`](../../buck2/) system.

It owns layered dependency payload/context/task-closure identity and the
historical pnpm closure experiments. It does not own Buck's general authority,
toolchain, language-action, artifact, Nix integration, observability, or
admission contracts.

| Document                             | Role                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------- |
| [requirements.md](./requirements.md) | Stable DMP-to-Buck dependency constraints                                  |
| [spec.md](./spec.md)                 | Closure identity, resolver projection, and consumer join                   |
| [`.decisions/`](./.decisions/)       | Historical accepted decisions; broader ownership points to `context/buck2` |
| [`.experiments/`](./.experiments/)   | Resolver, invalidation, and benchmark evidence                             |

Current implementation and migration status belong to the Buck roadmap and
GitHub refactor epic rather than this timeless dependency contract.
