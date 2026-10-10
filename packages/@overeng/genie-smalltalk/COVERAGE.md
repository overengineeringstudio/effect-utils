# Smalltalk declaration coverage

Authoritative grammar: `compoundingtech/smalltalk`, `crates/st3/src/graph.rs` at the pinned st revision used by CI. This library validates authoring inputs; the st daemon remains the final parser and runtime authority. Constructor field names are TypeScript camelCase only where KDL uses hyphens.

| Grammar node                                                                                                                                  | Status      | Notes                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                                                                                                                                       | Partial     | All 19 ALLOWED child names modeled; complex `render`, `harness`, `pty`, `exec`, authority and restart forms are **not** fully represented; avoid assuming full parser parity.                                        |
| `mission`, `step`, `gate`, `exec`, `depends-on`, `schedule`, `work`                                                                           | Partial     | Covers finite missions, step dependencies, tagged field/human gates, person assignments, exec and interval schedules. Mission-level gates, calendar schedules and additional step forms are not modeled. |
| `resource`                                                                                                                                    | Partial     | Three resource kinds modeled; upstream accepts more kinds.                                                                                                                                                           |
| `account`, `pty`, `host`, `doc`, `lane`, `observer`, `subscription`, `person`, `mission-run`, `planning-session`, `message`, `repair`, `stop` | Not covered | Root grammar nodes omitted.                                                                                                                                                                                          |
| `version 2`                                                                                                                                   | Covered     | All emitted documents start with this directive.                                                                                                                                                                     |

The conformance test is opt-in with `ST_BIN` pointing to a binary built from the exact pinned upstream revision. Its scratch daemon must be isolated from the caller's runtime directories.

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

Author `dependsOn` as a nonempty list of `{ step, state: 'completed' }` entries. All entries must be satisfied (AND); every target must name an existing mission step. Omit the field for independent steps. Singleton dependencies use a one-item list; the former object form is no longer accepted.

The renderer emits one `depends-on` block with a `step` child per entry, preserving authored order. Native support is confirmed in `compoundingtech/smalltalk`, `crates/st3/src/mission.rs:1290` (collects every `depends-on` block) and `:1929-1949` (collects every nested `step` entry). The optional isolated-daemon conformance fixture includes a two-parent join.

## Required mission reporting

Every `MissionSchema` declaration requires `reportTo: importedAgent`, where `importedAgent` is an agent declaration satisfying `typeof AgentSchema.Encoded`. Import the supervisor's seat declaration (or the manager's when there is no supervisor); do not author a subject string. The reference retains the imported declaration and any kit metadata, while only its ID is lowered to the native mission-header property `report-to="agent/ID"`. It does not copy launch configuration into the mission.

Omission, bare agent/person strings, and `reportTo: 'none'` are rejected. There is intentionally no opt-out: requiring a recipient prevents silently unobserved failures. Native st accepts agents only; reach a person through that person's agent. The DSL does not add unsupported person targets or step-level reporting.

Native support starts at `compoundingtech/smalltalk` commit `3e7efce0663826a4e2bb517b2481b284e8df5f76` (#1984). Use that commit or a descendant for `ST_BIN` and before publishing generated missions. The daemon sends one message per failed, cancelled, or stalled run event; stalls default to 30 minutes without progress. Completion reporting and stall-duration overrides are not exposed here. Messages identify the run, mission, and relevant steps, not failure reasons or step output. An unavailable reporting agent produces a native `report-to` fault rather than a delivered message.

Changing `reportTo` changes the mission revision, not an agent's launch declaration. Existing runs retain the reporter recorded when they started; new runs use the new revision. Unit tests assert required/object-only authoring, invalid-reference rejection, and the exact mission-header KDL. The opt-in native conformance fixture publishes reporting missions through an isolated daemon.

## Imported agent references

Author `StepSchema.assignedTo` with an imported agent declaration or `person('person/NAME')`. Each `AgentSchema.under[].target` and mission `reportTo` remains agent-only. Strings (including `` `agent/${id}` ``) are not references. IDs are structural, not a registry or global enum: independently declared valid agent IDs work without registering them.

`AgentReference` exposes the structural `{ readonly id: string }` view to avoid recursively expanding agent authoring types. `AgentReferenceSchema` defers validation to the complete `AgentSchema`, including harness routing, launch conflicts, nested supervisor references, and ID validation; empty ID path segments are rejected as for `ReportToSchema`. The imported object and any kit metadata retain their identity. The existing `ReportToSchema` API continues to expose the complete agent authoring type.

Lowering emits only `assigned-to "agent/ID"` or `under "agent/ID" reason="..."`, never the referenced agent's launch configuration or kit metadata. There is no separate mission-agent launch API. Unit coverage includes exact KDL, object-only authoring types, invalid IDs and launches, and retained imported metadata.

## Attributed human gates

Gates are tagged: existing field gates require `kind: 'field'`; human gates use
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
import { mission, person } from '@overeng/genie-smalltalk'
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
      gate: {
        kind: 'human',
        name: 'Approve the bounded cutover',
        reviewer: person('person/schickling'),
        question: 'Apply the reviewed configuration and rollback plan?',
      },
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
Repin merged immutable DSL revisions and migrate all field-gate callers to the
tagged form together; already-running native runs retain their definitions.
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
