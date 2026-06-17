# Spec - React Owned Region

This document specifies the React owned-region realization's stack-level role.
It builds on [requirements.md](./requirements.md).

The React owned-region realization is refined by
`packages/@overeng/notion-react/docs/vrs/`.

React maps JSX candidate trees, cache trees, live block observations, mutation
plans, fallbacks, and checkpoints to the shared sync vocabulary where useful.
It keeps renderer-specific keyed diffing, host config, page operation ordering,
and cache persistence package-local.
