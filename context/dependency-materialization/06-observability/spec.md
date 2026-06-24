# Dependency Materialization Observability Spec

This document specifies dependency materialization producer facts. It builds on
[requirements.md](./requirements.md).

Status: **Draft**

## Surfaces

Sandboxed Nix builders emit JSON records on registered log prefixes:

```text
workspace-projector: {"schema":"nix-bridge/v1","v":1,"event":"projected-workspace","package":"packages/app","bytes":9846784}
workspace-prep: {"schema":"nix-bridge/v1","v":1,"event":"prepared-deps-scan","profileId":"pnpm:...","status":"ok"}
workspace-restore: {"schema":"nix-bridge/v1","v":1,"event":"restore","profileId":"pnpm:...","duration_ms":421}
cli-build: {"schema":"nix-bridge/v1","v":1,"event":"smoke","program":"my-cli","status":"ok"}
```

Prose logs remain ordinary logs. Consumers must derive semantic spans or
events only from valid JSON bridge records.

## Phase Hierarchy

Bridge records may use local span ids:

```text
workspace-prep: {"schema":"nix-bridge/v1","v":1,"event":"span-start","span_id":"prep","phase":"prepare"}
workspace-prep: {"schema":"nix-bridge/v1","v":1,"event":"span-event","span_id":"prep","name":"scan","status":"ok"}
workspace-prep: {"schema":"nix-bridge/v1","v":1,"event":"span-end","span_id":"prep","status":"ok","duration_ms":1200}
```

The local ids are builder-local. They are not W3C trace context and do not
carry authority outside the build log translation boundary.

## Required Fields

Fact records that describe dependency materialization include:

- `schema`;
- `v`;
- `event`;
- phase or operation name;
- status;
- profile id or safe profile reference when available;
- repo-relative path fields when paths are needed;
- duration and byte/file counts when available.
