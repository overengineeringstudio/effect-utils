# Smalltalk declaration coverage

Authoritative grammar: `compoundingtech/smalltalk`, `crates/st3/src/graph.rs` and `mission.rs` at native revision `d5e2302`. This library validates authoring inputs; the st daemon remains the final parser and runtime authority. Constructor field names are TypeScript camelCase only where KDL uses hyphens.

| Grammar node                                                                                               | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                                                                                                    | Partial     | All 19 ALLOWED child names modeled; complex `render`, `harness`, `pty`, `exec`, authority and restart forms are **not** fully represented; avoid assuming full parser parity.                                                                                                                                                                                                                                                              |
| `mission`, `step`, `gate`, `exec`, `depends-on`, `schedule`, `work`                                        | Partial     | Up to three goals; unique repeated gates; native exists/empty/has/lacks and field predicates; merged/CI/exec/human gates; completed/failed/terminal dependency fan-in; retry attempts and backoff; explicit completion frontiers and finalization. Imported agent/person references, required reporting, and attributed human-gate contracts remain intact. Additional native gate/dependency and calendar schedule forms are not modeled. |
| `loop`, `round`, `until`, `on-exhausted`, `attention`                                                      | Partial     | Ordered bounded sequential loops, optional until gates, explicit step-only round completion/finalization, fail/succeed exhaustion, and fail-only attributed warning/error attention. Removed collection/candidate loop forms are not revived.                                                                                                                                                                                              |
| `input`, step `produces`                                                                                   | Partial     | Native text/resource inputs and scalar-constrained graph products; typed authoring references retain exact input/product ownership. Mission-level products and resource-field projections are not added.                                                                                                                                                                                                                                   |
| `produces-mission`, `uses-mission`                                                                         | Covered     | Attempt-bound child mission production, exact `mission@64hex` revision use, and output-of use. Output consumers require an existing child-producing step in the same phase and an explicit completed dependency. Public authoring uses `produces: childMission` and agentless `waitFor`; the wire schema retains native fields.                                                                                                            |
| `resource`                                                                                                 | Partial     | vcs.repository, filesystem.file, vcs.pull-request and vcs.ref. Additional native resource kinds are not modeled.                                                                                                                                                                                                                                                                                                                           |
| `doc`, `observer`, `subscription`                                                                          | Partial     | Immutable document bindings and step pins, named/pinned document gates, github.ref observers selecting head/ancestors, and message subscriptions with field conditions. Mission/step/round declarations preserve native run scoping and alias rewriting. Other observer providers and subscription delivery modes are not modeled.                                                                                                         |
| `account`, `pty`, `host`, `lane`, `person`, `mission-run`, `planning-session`, `message`, `repair`, `stop` | Not covered | Additional root grammar nodes omitted.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `version 2`                                                                                                | Covered     | All emitted documents start with this directive.                                                                                                                                                                                                                                                                                                                                                                                           |

Native conformance is opt-in: `ST_BIN` selects the production binary for the agent-attributed round-trip; `ST_FIXTURE_BIN` selects upstream's separately compiled, pinned `st3-fixture` test-support binary for synthetic-person gate semantics. Both use isolated private runtime directories. The fixture mode does not prove production person authentication; see [the acceptance boundary](./HUMAN_GATE_ACCEPTANCE.md).
The unified conformance target is native `d5e2302`. Assertions derive run subjects from the native start response, including mission-scoped run IDs; they do not assume the legacy `mission-run/ID` shape.

Daemonless native KDL parsing is an upstream prerequisite for a pinned-binary
CI parse check. At native revision `14311260cf907e9b8dabf629588314e63dec3665`,
`st apply --dry-run` still calls the daemon's `/v1/sets/preview`, and
`st missions check` calls `/v1/gate-checks`. The daemonless `st2 validate`
command parses the legacy agent catalog, not the st3 mission/schedule grammar,
so it is not a substitute. Add a native offline st3 document parse/check
entrypoint before wiring its pinned binary into this package's CI; retain the
existing isolated-daemon conformance test meanwhile. A binary predating native
mission reporting must not be used to check generated `report-to` declarations.

## Step dependency fan-in

Author `dependsOn` as a scalar step ID, `{ step, state }`, or a nonempty list of either. `state` is `completed`, `failed`, or `terminal`; step IDs default to `completed`. All entries must be satisfied (AND); every target must name a graph node in the same normal/final phase. Omit the field for independent work. Scalar and singleton declarations emit byte-identical KDL. Handle authoring additionally accepts a `StepHandle` directly or in the list; it defaults to completed and retains exact identity/scoping checks.

The renderer emits one `depends-on` block with a `step` child per entry, preserving authored order. Native support is confirmed in `compoundingtech/smalltalk`, `crates/st3/src/mission.rs:1290` (collects every `depends-on` block) and `:1929-1949` (collects every nested `step` entry). The optional isolated-daemon conformance fixture includes a two-parent join.

## Required mission reporting

Every `MissionSchema` declaration requires `reportTo: importedAgent`, where `importedAgent` is an agent declaration satisfying `typeof AgentSchema.Encoded`. Import the supervisor's seat declaration (or the manager's when there is no supervisor); do not author a subject string. The reference retains the imported declaration and any kit metadata, while only its ID is lowered to the native mission-header property `report-to="agent/ID"`. It does not copy launch configuration into the mission.

Omission, bare agent/person strings, and `reportTo: 'none'` are rejected. There is intentionally no opt-out: requiring a recipient prevents silently unobserved failures. Native st accepts agents only; reach a person through that person's agent. The DSL does not add unsupported person targets or step-level reporting.

Native support starts at `compoundingtech/smalltalk` commit `3e7efce0663826a4e2bb517b2481b284e8df5f76` (#1984). Use that commit or a descendant for `ST_BIN` and before publishing generated missions. The daemon sends one message per failed, cancelled, or stalled run event; stalls default to 30 minutes without progress. Completion reporting and stall-duration overrides are not exposed here. Messages identify the run, mission, and relevant steps, not failure reasons or step output. An unavailable reporting agent produces a native `report-to` fault rather than a delivered message.

Changing `reportTo` changes the mission revision, not an agent's launch declaration. Existing runs retain the reporter recorded when they started; new runs use the new revision. Unit tests assert required/object-only authoring, invalid-reference rejection, and the exact mission-header KDL. The opt-in native conformance fixture publishes reporting missions through an isolated daemon.

## Imported agent references

Author mission and step `assignedTo` with an imported agent declaration or `person('person/NAME')`. Mission-level assignment remains a native default selector: it is not copied into every worker step. Each `AgentSchema.under[].target` and mission `reportTo` remains agent-only. Strings (including `` `agent/${id}` ``) are not references. IDs are structural, not a registry or global enum: independently declared valid agent IDs work without registering them.

`AgentReference` exposes the structural `{ readonly id: string }` view to avoid recursively expanding agent authoring types. `AgentReferenceSchema` defers validation to the complete `AgentSchema`, including harness routing, launch conflicts, nested supervisor references, and ID validation; empty ID path segments are rejected as for `ReportToSchema`. The imported object and any kit metadata retain their identity. The existing `ReportToSchema` API continues to expose the complete agent authoring type.

Lowering emits only `assigned-to "agent/ID"` or `under "agent/ID" reason="..."`, never the referenced agent's launch configuration or kit metadata. There is no separate mission-agent launch API. Unit coverage includes exact KDL, object-only authoring types, invalid IDs and launches, and retained imported metadata.

## Attributed human gates

Gates are an ordered array of tagged native data, optionally built with `gate.*` constructors. Field gates require `kind: 'field'`, `path`, `subject`, `operator` and `value`; the former nested `field` object is rejected. Human gates use
`kind: 'human'`, a distinct `person()` reviewer, optional `question` and repeated
unique `review` subjects. Omitted `mode` lowers to native `mode="approve"`.
Approve passes on approval and fails on rejection; `mode: 'feedback'` is for
worker completion review and can request changes on a new attempt. It is rejected
on agentless steps. Gates on worker steps review completed work, not permission
to begin it.

For a risky action, put an **agentless approve checkpoint before the worker**
and depend on its completion. This illustrative Berlin cutover declares no
live operation or artifact:

```ts
import { gate, mission, person } from '@overeng/genie-smalltalk'
import owner from './agents/owner.ts'
import worker from './agents/worker.ts'

mission({
  id: 'home/berlin/cutover',
  state: 'ready',
  reportTo: owner,
  goal: 'Apply only the reviewed Berlin cutover plan.',
  steps: [
    {
      id: 'approve-cutover',
      agentless: true,
      timeout: '1d',
      gates: [
        gate.human({
          name: 'Approve the bounded cutover',
          reviewer: person('person/schickling'),
          question: 'Apply the reviewed configuration and rollback plan?',
        }),
      ],
    },
    {
      id: 'apply-cutover',
      assignedTo: worker,
      dependsOn: [{ step: 'approve-cutover', state: 'completed' }],
      goal: 'Apply precisely the approved plan.',
    },
  ],
})
```

Critical is the only supported/default tier: silence never grants approval.
The step timeout fails an unanswered agentless checkpoint; it is not a human
consultation window. The daemon owns the current request, actor attribution,
stale-episode fences and native attention cards. `person()` is a named reference,
not an authenticated person credential; stronger person-only authority is tracked
in [smalltalk#2184](https://github.com/compoundingtech/smalltalk/issues/2184).
Existing explicit native delegation is not a timed fallback or reusable consent.

There is deliberately no `tier`, `policy`, `scope`, `window`, `fallback` or
`humanOnly` authoring field: native window/fallback and scoped consent primitives
must exist before the DSL exposes them. A prior gate approval cannot satisfy a
new episode. Review exact artifacts with immutable `doc/...@REVISION` subjects.
Repin merged immutable DSL revisions and migrate singular `gate` fields and the old nested field predicate to the native `gates` array together; already-running native runs retain their definitions.
See [the isolated-daemon acceptance plan](./HUMAN_GATE_ACCEPTANCE.md) before a
risky mission relies on consent reuse or consultative fallback.

## Nested agent tasks

Agent `pty` and `exec` tasks accept exactly one `command` or `argv` launch form and optional `host`/`workspace`; they do not accept or render `restart`. Excess task fields are rejected even when the containing agent is referenced rather than rendered. Unit assertions cover both task authoring types and runtime rejection, including an explicitly undefined `restart`. Root agent restart policy is unchanged; mission-step `ExecSchema.restart` remains a separate modeled field.

## Root agent contract and explicit routing

All root agents use the generalist runtime and one contract: orchestrate and delegate heavy work to harness subagents and missions. Inline work is limited to accountable-boundary actions (pairing, asks, mission disposition, final merge/publish) and minimal small sequential commands or fixes. `AgentSchema` exposes no per-agent `role`, `persona`, or `runtime` selector; constructors reject these fields.

Every OMP or Codex harness declaration requires nonempty `model` **and** `effort`, including agent declarations referenced by missions. OMP effort is `low | medium | high`; Codex model and effort are provider-native strings. Neither harness silently inherits provider routing defaults. Command/argv agents and agentless mission steps have no harness routing fields. Mission steps assigned to an agent use that agent's declaration; the DSL has no separate mission-agent launch configuration.

Codex supports optional `args` and `resume: { session }`. Resume lowers to `env.ST3_NATIVE_RESUME_SESSION`, binding the exact native thread; conflicting authored values are rejected without changing explicit model/effort routing.

## OMP conversation recovery

OMP harness intent accepts `resume: { transcript: '/sessions/example.jsonl' }` to emit `args "--resume" "/sessions/example.jsonl"`, or `resume: 'latest'` to emit `args "--continue"`. The `omp({ model, effort, resume })` helper accepts the same optional field. Omitted recovery intent starts a fresh conversation.

Use an exact transcript for managed seats when preserving a particular conversation; `latest` selects the newest session in the harness session directory. Paths are interpreted on the seat host and validated by the OMP launcher, not resolved by this generator. Recovery is a mutually exclusive typed choice, not free-form harness arguments. Applying a declaration does not itself authorize restarting a seat.

## Goals, retries and graph phases

The field remains `goal`: author one nonempty string or a nonempty array of one to three strings. Scalar and singleton-array declarations emit exactly the same `goal` node; arrays preserve authored order. There is no plural `goals` alias. Mission goals are required, while step goals are optional.

`retry: { attempts, backoff? }` counts the initial attempt in its 1–100 bound. Backoff accepts positive native durations and explicit zero durations. Native exec gates preserve command, host, workspace, environment and time-limit semantics; reserved st context keys cannot be overridden, while application keys and `PATH` remain authorable.

Mission `steps` preserves ordered step/loop nodes. `completion` selects `all-steps-exhausted` or an explicit step-state frontier, which cannot reference final steps. `finally` contains final-phase steps; dependencies cannot cross the normal/final boundary. Loops require `maxRounds` 1–100 and an explicitly completed step-only `round`; `until` is optional. Exhaustion can fail or succeed, and only failure can request attributed warning/error attention. Feedback human gates remain restricted to worker step gates, not mission or loop-until gates.

## Documents and ref watchers

`document({ id, hash })` binds a name to existing immutable bytes; step `documents` always contains exact `doc/NAME@64hex` pins. `doc` is a tagged-template subject reference for `gate.document`, not a declaration writer. Document gates can wait for a name or a pinned version. The generator does not upload or invent document content.

`observer({ id, resource, provider: 'github.ref', locator, fields, every? })` accepts `OWNER/REPO@REF`, including slash-containing branch names, and unique nonempty `head`/`ancestors` fields. `subscription` models message delivery with unique nonempty `on` fields and optional `is`/`starts-with`/`contains` field conditions. Resources, documents, observers and subscriptions can also be declared on missions, steps and loop rounds. Native st owns run-scoped IDs and subscription alias rewriting.

The public upstream-repin fixture preserves the full bounded retry/loop/goal graph. Its independent KDL and typed form include the same required reporting agent; the opt-in native round-trip compares their normalized revision without starting network-dependent work. The same isolated daemon stores real document bytes and checks run-scoped watcher declarations.

## Scoped handles and plain graph materialization

`step({ id: 'review', missionId: 'landing', assignedTo: importedWorker })` returns a renderable `StepHandle<'landing'>`. `completed`, `failed` and `terminal` retain explicit state dependencies; a direct handle defaults to completed. Literal mission scopes reject foreign handles statically, and assembly checks exact handle membership in the same phase even when IDs collide. A handle already owned by another mission cannot be reused.

Plain `MissionSchema.Encoded` declarations remain first-class. For graph loaders that JSON-round-trip module defaults, `missionWire(input)` materializes validated authoring handles to native plain declaration data before serialization. Symbol/weak-map authoring identity is not a JSON wire format. Agent/person references retain the current structural and attribution contracts.

## Per-run inputs and graph products

`input.text('commit')` and `input.resource({ name: 'pr', kind: 'vcs.pull-request' })` are declared in mission `inputs`. Native input declarations contain `name` and text/resource `kind`; resource kind metadata is static authoring intent, not a native input schema property. Native st pins the actual supplied resource observation when the run starts.

`t` interpolates typed input references and context values into native text; `runId` denotes `${ST_MISSION_RUN}`. Plain `${input.NAME}` strings remain native wire authoring. No `${input.pr.head_sha}` resource-field projection is invented: companion text inputs supply exact commit/locator values when needed.

Named `produces` graph products expose `step.products.NAME`. `product.resource({ kind, subject?, fields })` requires a resource kind, and omitted subjects are scoped by run, producing step and product name. `product.field({ subject, fields })` expresses scalar constraints on a message/agent/exec/pty subject. Work must actually publish the required graph facts; constructors do not create them. Typed gate references check declared input identity and included product ownership, including plain and final steps and loop gate placements. One product handle cannot be aliased under multiple output names.

The synthetic public PR-landing fixture exercises resource/text input pins and a review → CI → land graph; its config-time fragment exercises the equivalent literal PR flow. The opt-in native test asserts that later resource observations do not replace a run's pinned input.

## Native gate authoring

Use `gate.human`, `gate.exec`, `gate.fieldIs`, `gate.merged(pr(repo, number))`, `gate.ciPassed(check, { repo, commit | branch })`, ``gate.document(doc`SUBJECT`)``, `gate.exists`, `gate.empty`, `gate.has` and `gate.lacks`. These produce tagged native gate data, not exec wrappers. `gate.render` renders an isolated gate for exact predicate assertions. Plain tagged native gate declarations remain accepted.

Gate names may be omitted for deterministic constructor-derived names. Explicit names preserve existing gate identities and should be retained when migrating a pinned native definition. Human approve is the default; explicit names, predicates, reviewer attribution and review targets are otherwise lowered unchanged.

## Child mission outputs and exact revisions

`produces: childMission` is a tagged-template descriptor of the child mission ID a worker will publish. It is a native attempt-bound contract, not an embedded mission or a mission launch configuration. A consumer uses `agentless: true`, `dependsOn: [producer]` and `waitFor: producer`; the producer must exist in the same phase and declare a child mission product. Waiting alone does not implicitly add a dependency. Exact fixed-revision use accepts only a mission ID plus a 64-hex revision, never a mutable mission name.

The wire representation remains native `producesMission` and `usesMission: { kind: 'revision', revision } | { kind: 'output', outputOf }`. `missionWire` resolves handle output identity before JSON serialization. Graph validation rejects missing/non-producing output targets, cross-phase references, and dependencies that do not explicitly require producer completion. The existing opt-in isolated native round-trip asserts `changed: false` after publishing and republishing an output-of parent; it does not fabricate a child revision or execute a child fixture.
