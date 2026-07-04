_For: contributors adding or reviewing an otel-scrape adapter · Assumes: the
parent otel-scrape vision/requirements/spec · Covers: how the adapter fleet is
organized and how to read it._

# The adapter fleet, in one picture

`otel-scrape` wraps a command and can enrich its span with records parsed from
the tool's output. This directory is the composable-VRS home for the _concrete_
adapters. The parent (`../`) states the mechanism-agnostic contract once; this
tree refines it per tool without restating it.

```
context/otel-utils/otel-scrape/                 vision + requirements + spec   (the contract)
└── adapters/                        requirements + spec + decisions (the fleet)
    ├── 01-oxlint/         req + spec  supported · diagnostics lane · reference
    ├── 02-pnpm/           req + spec  candidate  · phase lane · robust win
    ├── 03-deadnix/        req + spec  candidate  · diagnostics lane · thin
    ├── 04-nix/            req + spec  candidate  · phase lane · build path only
    ├── 05-vitest/         req + spec  supported · side-channel · run-level counts
    └── 06-node-cpuprofile/ req + spec supported · profile artifact (CAS)
```

Read top-down: the parent contract, then the fleet `requirements.md`
(`ADP-R*`), then a leaf. Each leaf requirement is namespaced and declares what
it `refines:` (e.g. `ADP.PNPM-R01 refines ADP-R03 refines parent R11`), so the
IDs read upward and no constraint is stated twice. A leaf's `requirements.md` is
the testable _what_ for that tool; its `spec.md` is the _how_ (source flag,
schema, parse, record mapping, registry additions).

## Two things to internalize

1. **Two lanes, not one.** A tool exposes either a _diagnostics_ source
   (per-item findings → events + counts: oxlint, deadnix) or a _phase_ source
   (start/stop activities → spans + metrics: pnpm, nix). A tool with no
   per-diagnostic source can still qualify on the phase lane — that is why pnpm
   is an adapter despite the parent audit correctly saying it has no diagnostics
   source.

2. **"No adapter" is a real, common, good answer.** Most slow un-adapted tasks
   (formatters, `nix-hash` fingerprint checks) have nothing structured to emit.
   They get the free `adapter = "none"` command span — a timed, named, pass/fail
   sub-span — not a bespoke parser. The fleet grows only where a declared,
   stable, structured source clears R08/R11, and even then a candidate must land
   a full vertical slice (parent decision 0012) before the CLI accepts its name.

The audit that produced this fleet and its ranking is
[.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md](.decisions/0001-adapter-fleet-audit-and-candidate-ranking.md);
the cross-cutting move that makes count-bearing adapters useful today is
[.decisions/0002-aggregate-counts-as-command-span-attributes.md](.decisions/0002-aggregate-counts-as-command-span-attributes.md).
