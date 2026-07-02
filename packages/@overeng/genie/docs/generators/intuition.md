# Generators — Intuition

_For: contributors adding a genie generator · Assumes: genie basics · Covers: what a
generator is and the one-source-of-truth rule_

## The idea

A **generator** is a genie artifact domain whose whole job is: you author ONE typed thing,
and every other representation of it is derived. Not "author here, also update there, and
a check keeps them honest" — one source, everything downstream generated from it.

The domains that need this are contracts consumed from several places at once: telemetry
semantic conventions (needed as TS constants, Effect Schemas, Rust bindings, and a Weaver
registry), config schemas, wire formats. Hand-mirroring those across languages is a
second schema by drift. A generator makes the mirror mechanical.

## Two layers

Every generator has two layers, and knowing which one you're in is the main thing to hold:

- **Layer 1 — the foundation.** A direct, faithful, no-frills model of the target's own
  world (for telemetry: the Weaver registry). Plain typed data in, output out. It's
  complete and you can use it _by itself_ when you want full control or the surfaces need to
  differ. It's the mechanism of record — the thing nothing is allowed to bypass.
- **Layer 2 — the ergonomic layer on top.** Opinionated helpers that make authoring nice
  and derive several artifacts from one source. What that looks like depends on the
  generator: for package.json/tsconfig it's composition helpers (`aggregateFromPackages`);
  for the telemetry generator it's an Effect-Schema surface where you author attributes as
  real Schemas, compose them, get decode/validate for free, and derive both the registry
  and the runtime encoder from one value. Effect Schema is _that_ generator's flavor, not
  the definition. Layer 2 is opt-in and always projects down to Layer 1.

The point of the split: Layer 1 keeps you from being locked into one authoring style, and
Layer 2 makes the common case delightful without hiding the foundation.

## The one rule: single source of truth, clean derivation

```
   Layer 2 (opinionated, Effect-Schema) ── author one value ──┐
                                                              │ derives several
        ┌──────────────┬───────────────┬────────────────┐    │
        ▼              ▼               ▼                ▼    │
   registry       runtime         (Rust/TS/           …     │  projects down to
   (Layer 1)      encoder          Effect bindings)         ▼
                                              ┌──────────────────────┐
                                              │ Layer 1 (foundation)  │→ output + external gate
                                              └──────────────────────┘
```

If you find yourself authoring the same fact twice — the attribute key in the registry AND
the attribute key in the runtime contract — that's the smell this subsystem exists to
remove. The goal is that adjacent surfaces (like the existing `@overeng/otel-contract`
runtime encoder) either derive from the source of truth or reference it, so there is one
place a name or a policy is decided.

A reconciling check ("these two agree") is allowed only as scaffolding while you migrate an
existing hand-authored surface onto the generator — a bridge, not the destination. The
destination is derivation.

## Why "generators" is a family

The first generator is [semantic conventions](./01-semantic-conventions/intuition.md)
(telemetry contracts via Weaver). But the shape recurs: a typed source, a resolved model,
multi-language bindings, provenance, composition across members, a validation gate. Rather
than each generator reinventing that, the family captures it once (here) and each generator
refines it. The in-flight otel-scrape telemetry registry is a generator-shaped thing that
should converge onto this family — we define the mechanism; it adopts it.

## Where it fits

The shared mechanism and its requirements are in [requirements.md](./requirements.md) and
[spec.md](./spec.md). Each generator lives in a numbered child dir with its own VRS,
refining the shared contract for its domain.
