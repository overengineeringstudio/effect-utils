# PR #775 — Autonomous Decision Log (PENDING RATIFICATION)

> Status: **provisional**. These are decisions an AI orchestrator made
> autonomously to avoid blocking on PR #775 ("land the full long-term Notion DB
> Markdown Sync VRS"). Each records the principled options considered, their
> trade-offs and evidence, and the chosen option. The human will later **ratify
> or revise** each. This file is NOT a VRS doc — VRS stays timeless; this is a
> time-bound rationale ledger that can be deleted once decisions are folded into
> ratified `decisions/NNNN-*.md` records or the PR epic.
>
> No secrets in this file (public repo). Notion token/page IDs are referenced by
> name only.

Last updated: 2026-06-14.

---

## D1 — Merge shape: single PR, milestones as commits

**Context.** Epic spans 8 phases across three packages. "Fully implement the VRS
in this PR" could mean one mega-PR or a stack.

**Options.**

- **(A) Single PR #775, milestones = incremental verified commits.** Each phase
  pushed when green (`check:all`) and sub-agent-reviewed. One merge lands the
  whole coherent system.
  - _Pro:_ matches "one coherent system lands at once"; no megarepo repin/merge
    order overhead (all in one repo); revertible per-commit.
  - _Con:_ large final diff; review must be milestone-by-milestone, not at merge.
- **(B) Megarepo PR stack** (one PR per phase, merged to `main` incrementally).
  - _Pro:_ smaller blast radius, faster feedback.
  - _Con:_ integrated system isn't "whole" until last PR; repin/order overhead;
    contradicts the user's explicit "same single PR".

**Decision: (A).** Explicitly confirmed by the user in conversation. **Ratified.**

---

## D2 — Live Notion (L6) is a hard gate for "done"; harness is unblocked

**Context.** "Fully e2e tested" includes L6 live Notion (schema drift, relation
completeness, files/comments capability, read-after-write settlement) — exactly
what fakes cannot prove. Public repo: secrets via `op://` only.

**Evidence gathered.**

- Token resolves: concrete ref
  `op://ialr3ed3depgv523r3bqojsyjq/mtvtayqbsvdt6yuniutk7t4bfe/u7q2coiqw5wdt4ab33yia3g4w4`
  (1Password item "Notion" → field "Effect API test env integration token").
- Integration has dedicated accessible scratch parents:
  - `@overeng/notion-datasource-sync e2e tests` page `36bf141b-18dc-8097-898d-c419155cba02`
  - `@overeng/notion-effect-client API test env` page `2dbf141b-18dc-8133-b921-c786d2b00ecf`
  - `notion-md e2e run ledger` page (sanitized live summaries)
- Existing harness already reads `NOTION_API_TOKEN`, `NOTION_TEST_PARENT_PAGE_ID`,
  `NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID`, with allowlist + cleanup-ledger guards
  and `NOTION_MD_LIVE_REQUIRED=1` / `NOTION_DATASOURCE_SYNC_LIVE=1` opt-in gates.

**Options.**

- **(A) L6 live mandatory for done; run it autonomously against the existing
  synthetic allowlisted workspace, cleanup-ledger-backed.** Selected.
- (B) Accept L0–L5 + L7 green and defer live to human. Rejected — fakes can't
  prove Notion API semantics; the VRS's core safety claims (proof-based mutation,
  relation completeness, settlement) are exactly the live-only surface.

**Decision: (A).** Live is in scope and unblocked. Tokens are session-injected
via env at test time (never written to files/commits). If a _new_ live scenario
needs a parent page the integration can't reach, that single scenario becomes a
ratification-gated TODO rather than blocking the milestone.

---

## D3 — Shared property-write core lives in a new `@overeng/notion-property-write` package

**Context (Phase 3).** A shared core validates `PropertyWriteProof` → allow/block
guard decisions, consumed by BOTH notion-md (`StandaloneLiveProofProvider`) and
datasource-sync (`DatasourceWorkspaceProofProvider`). Must be entrypoint-neutral
(R12). Schema package (`notion-effect-schema`) is deliberately restricted to
values/codecs/descriptors/write-class — NO authority/proof (Phase 1 boundary).

**Dependency evidence.** `notion-datasource-sync` → `notion-md` →
`notion-effect-client` → `notion-effect-schema` → `notion-core`. Common ancestors
of both consumers: `notion-effect-client`, `notion-effect-schema`. Repo strongly
favors fine-grained `@overeng/*` packages.

**Options.**

- **(A) New `@overeng/notion-property-write` package** (pure core: proof schema +
  guard evaluator; depends only on `notion-effect-schema`). Providers stay in
  their IO-bearing homes (notion-md, datasource-sync).
  - _Pro:_ entrypoint-neutrality is _structural_ — neither CLI owns the core;
    cleanest dependency story; matches house style of small packages.
  - _Con:_ new package = genie/tsconfig/CI scaffolding + one more thing to
    version.
- **(B) Put the pure core in `notion-effect-client`.**
  - _Pro:_ no new package; client already owns Notion write semantics + schema
    reads; both consumers already depend on it.
  - _Con:_ mixes pure guard logic with an IO client; weaker boundary; tempts
    future coupling of proof logic to live client internals.
- (C) Put it in `notion-effect-schema`. Rejected — violates the Phase 1 schema
  boundary (no authority/proof/convergence).
- (D) Duplicate per consumer. Rejected — violates R09/R12 (shared semantics,
  entrypoint neutrality).

**Decision: (A)** new `@overeng/notion-property-write`. Long-term-ideal boundary
wins given the repo's small-package norm. **Revisit trigger:** if the package
turns out to be <~150 LOC of pure types with no independent reuse, collapse into
`notion-effect-client` (B) at ratification.

---

## D4 — VRS authority: cross-cutting `context/notion-db-markdown-sync` is canonical for the integrated system

**Context.** Three VRS doc sets exist: cross-cutting `context/notion-db-markdown-sync`
(vision/requirements/spec/glossary + 13 decisions), per-package
`notion-md/docs/vrs`, and `notion-datasource-sync/docs/vrs`.

**Options.**

- **(A) Cross-cutting `context/` VRS is the canonical integrated-system contract;
  per-package VRS docs must not contradict it and scope down to their package.**
  Selected.
- (B) Per-package VRS canonical, context/ is a summary. Rejected — the whole
  point of #775 is one coherent system across packages; the integrated contract
  must have a single home.

**Decision: (A).** Phase 0 reconciles all per-package VRS to the cross-cutting
contract. `vision.md` / `requirements.md` are protected (no edits without human
sign-off); specs may be updated freely to track implementation but must trace to
requirements. The PR body is the implementation epic; VRS stays timeless.

---

## D5 — Clean break v1: delete legacy datasource-sync public surfaces, no compat shims

**Context.** Already-landed datasource-sync exposes `rows`/`_nds_*`-style surfaces
and unversioned layouts. R05 mandates only the v1 surface (`pages`, versioned
paths, hidden `.notion/v1`), failing closed on unknown/mixed namespaces.

**Options.**

- **(A) Hard clean break: remove `rows`/`_nds_*`/unversioned layouts entirely;
  no migration path; unknown namespace fails closed with tracking guidance.**
  Selected (T03 + R05 + epic "Decisions: Clean v1 workspace").
  - _Pro:_ one product contract, no dual-surface ambiguity (vision "What This Is
    Not"); pre-release so no external users to migrate.
  - _Con:_ existing tests/fixtures referencing old surfaces must be rewritten,
    not adapted.
- (B) Keep `rows` as a read-only alias / provide migration. Rejected — VRS
  explicitly forbids public `rows` alias and implicit migration (T03, R05, Decision
  0013-versioned-clean-break-workspace).

**Decision: (A).** Treat legacy surfaces as deletable; rewrite dependent tests to
the v1 surface rather than preserving them (still honoring "never silently delete
tests" — each removal is justified by the clean-break requirement and replaced by
a v1-surface test).

---

## D6 — Execution model: orchestrator + per-milestone implement → adversarial review → refine → commit/push

**Context.** User: "you only orchestrator, validate and manage the plan… on each
milestone commit and push and have sub agents review, verify, critique and
refine." Maximize throughput via sub-agents; keep main context clean.

**Decision (process, not architecture).**

- Each phase = one milestone. Per milestone:
  1. Spawn implementation sub-agent(s) (scoped to the phase's primary file areas).
  2. Gate locally: `dt check:quick` then `dt check:all --no-tui` (+ targeted live
     where the phase's correctness is live-only).
  3. Spawn independent review/critique sub-agent(s) (adversarial: correctness,
     VRS-trace, simplicity, fail-closed coverage). Distinct agent from implementer.
  4. Refine from review; re-gate.
  5. Commit + push; update the #775 epic checklist + this file if a new decision
     arose.
- Orchestrator (me) does not write production code; I validate, route, and keep
  the epic + decision log current.
- `axe work` records milestone start/update/handoff; epic checkboxes are the
  durable public progress surface.

**Confidence: high** (directly from user instruction). **Ratified.**

---

## D7 — Definition of done / verification gating

**Decision.** "Done" for #775 = all of:

- Every named guard (R13) has ≥1 test at the cheapest sufficient layer (L0–L7
  matrix).
- Every user-visible workflow has ≥1 CLI/E2E test.
- L6 live covers the API-semantic-only cases (schema drift, relation
  completeness, files/comments capability, read-after-write settlement).
- `dt check:quick --no-tui` and `dt check:all --no-tui` green before each
  milestone handoff; full live suite green before final ready-for-review.
- Every spec section traces to a requirement; no VRS doc presents two competing
  contracts (Phase 0 acceptance).

**Revisit trigger:** if a live scenario is structurally unprovable in the synthetic
workspace, it is documented as a ratification-gated gap, not silently dropped.

---

## D8 — Webhook scope boundary (Phase 7)

**Decision.** Package surface accepts **decoded dirty hints** only; subscription
provisioning + hosted-receiver/Worker lifecycle stay OUT of #775 (epic + Decision
on external signals). Hints are followed by fresh reads before planning — webhooks
are never a correctness source. Matches the existing `webhook/` modules' intent.
**Confidence: high** (explicit in epic).

---

## D9 — Non-body lifecycle v1 boundaries fail closed (Phase 6)

**Decision.** v1 supports only: object-store refs, volatile-URL exclusion,
preservation, proven external-URL attach. Durable byte upload/replacement/delete,
comment writes, untracked relation lookup, writable debug views all **fail closed
with named guards + dry-run-visible diagnostics**. Destructive body modes
(unknown-block deletion, Roughdraft review markup) stay explicit, observable,
dry-run-covered. **Confidence: high** (explicit in epic Decisions/Phase 6).

---

## Open items explicitly deferred to ratification

- D3 package-vs-client collapse (see revisit trigger).
- Any live scenario found structurally unprovable in the synthetic workspace.
- Final naming of v1 SQLite read-only surfaces (`changes`, `conflicts`,
  `sync_status`, `schema`, `debug_*`) — provisional from epic; will firm up in
  Phase 4 and trace back here if changed.
