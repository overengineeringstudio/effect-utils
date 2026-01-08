# Patches

## effect-distributed-lock@0.0.11

This patch removes the root `RedisBacking` re-export to avoid loading the optional `ioredis` peer dependency when importing from the package root.

Upstream issue: https://github.com/ethanniser/effect-distributed-lock/issues/10
