# Smalltalk declaration coverage

Authoritative grammar: `compoundingtech/smalltalk`, `crates/st3/src/graph.rs` at the pinned st revision used by CI. This library validates authoring inputs; the st daemon remains the final parser and runtime authority. Constructor field names are TypeScript camelCase only where KDL uses hyphens.

| Grammar node                                                                                                                                  | Status      | Notes                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                                                                                                                                       | Partial     | All 19 ALLOWED child names modeled; complex `render`, `harness`, `pty`, `exec`, authority and restart forms are **not** fully represented; avoid assuming full parser parity.                                        |
| `mission`, `step`, `gate`, `exec`, `depends-on`, `schedule`, `work`                                                                           | Partial     | Covers finite mission, step dependencies, field gates, exec and interval schedule forms only. Mission declarations embedded within missions, calendar schedules, cancellation and additional step forms not modeled. |
| `resource`                                                                                                                                    | Partial     | Three resource kinds modeled; upstream accepts more kinds.                                                                                                                                                           |
| `account`, `pty`, `host`, `doc`, `lane`, `observer`, `subscription`, `person`, `mission-run`, `planning-session`, `message`, `repair`, `stop` | Not covered | Root grammar nodes omitted.                                                                                                                                                                                          |
| `version 2`                                                                                                                                   | Covered     | All emitted documents start with this directive.                                                                                                                                                                     |

The conformance test is opt-in with `ST_BIN` pointing to a binary built from the exact pinned upstream revision. Its scratch daemon must be isolated from the caller's runtime directories.

## Step dependency fan-in

Author `dependsOn` as a nonempty list of `{ step, state: 'completed' }` entries. All entries must be satisfied (AND); every target must name an existing mission step. Omit the field for independent steps. Singleton dependencies use a one-item list; the former object form is no longer accepted.

The renderer emits one `depends-on` block with a `step` child per entry, preserving authored order. Native support is confirmed in `compoundingtech/smalltalk`, `crates/st3/src/mission.rs:1290` (collects every `depends-on` block) and `:1929-1949` (collects every nested `step` entry). The optional isolated-daemon conformance fixture includes a two-parent join.

## Required mission reporting

Every `MissionSchema` declaration requires `reportTo: importedAgent`, where `importedAgent` is an agent declaration satisfying `typeof AgentSchema.Encoded`. Import the supervisor's seat declaration (or the manager's when there is no supervisor); do not author a subject string. The reference retains the imported declaration and any kit metadata, while only its ID is lowered to the native mission-header property `report-to="agent/ID"`. It does not copy launch configuration into the mission.

Omission, bare agent/person strings, and `reportTo: 'none'` are rejected. There is intentionally no opt-out: requiring a recipient prevents silently unobserved failures. Native st accepts agents only; reach a person through that person's agent. The DSL does not add unsupported person targets or step-level reporting.

Native support starts at `compoundingtech/smalltalk` commit `3e7efce0663826a4e2bb517b2481b284e8df5f76` (#1984). Use that commit or a descendant for `ST_BIN` and before publishing generated missions. The daemon sends one message per failed, cancelled, or stalled run event; stalls default to 30 minutes without progress. Completion reporting and stall-duration overrides are not exposed here. Messages identify the run, mission, and relevant steps, not failure reasons or step output. An unavailable reporting agent produces a native `report-to` fault rather than a delivered message.

Changing `reportTo` changes the mission revision, not an agent's launch declaration. Existing runs retain the reporter recorded when they started; new runs use the new revision. Unit tests assert required/object-only authoring, invalid-reference rejection, and the exact mission-header KDL. The opt-in native conformance fixture publishes reporting missions through an isolated daemon.

## Imported agent references

Author `StepSchema.assignedTo` and each `AgentSchema.under[].target` with an imported agent declaration, just like mission `reportTo`. Strings (including `` `agent/${id}` ``) are not references. IDs are structural, not a registry or global enum: independently declared valid agent IDs work without registering them.

`AgentReference` exposes the structural `{ readonly id: string }` view to avoid recursively expanding agent authoring types. `AgentReferenceSchema` defers validation to the complete `AgentSchema`, including harness routing, launch conflicts, nested supervisor references, and ID validation; empty ID path segments are rejected as for `ReportToSchema`. The imported object and any kit metadata retain their identity. The existing `ReportToSchema` API continues to expose the complete agent authoring type.

Lowering emits only `assigned-to "agent/ID"` or `under "agent/ID" reason="..."`, never the referenced agent's launch configuration or kit metadata. There is no separate mission-agent launch API. Unit coverage includes exact KDL, object-only authoring types, invalid IDs and launches, and retained imported metadata.

## Nested agent tasks

Agent `pty` and `exec` tasks accept exactly one `command` or `argv` launch form and optional `host`/`workspace`; they do not accept or render `restart`. Excess task fields are rejected even when the containing agent is referenced rather than rendered. Unit assertions cover both task authoring types and runtime rejection, including an explicitly undefined `restart`. Root agent restart policy is unchanged; mission-step `ExecSchema.restart` remains a separate modeled field.

## Root agent contract and explicit routing

All root agents use the generalist runtime and one contract: orchestrate and delegate heavy work to harness subagents and missions. Inline work is limited to accountable-boundary actions (pairing, asks, mission disposition, final merge/publish) and minimal small sequential commands or fixes. `AgentSchema` exposes no per-agent `role`, `persona`, or `runtime` selector; constructors reject these fields.

Every OMP or Codex harness declaration requires nonempty `model` **and** `effort`, including agent declarations referenced by missions. OMP effort is `low | medium | high`; Codex model and effort are provider-native strings. Neither harness silently inherits provider routing defaults. Command/argv agents and agentless mission steps have no harness routing fields. Mission steps assigned to an agent use that agent's declaration; the DSL has no separate mission-agent launch configuration.

Codex supports optional `args` and `resume: { session }`. Resume lowers to `env.ST3_NATIVE_RESUME_SESSION`, binding the exact native thread; conflicting authored values are rejected without changing explicit model/effort routing.

## OMP conversation recovery

OMP harness intent accepts `resume: { transcript: '/sessions/example.jsonl' }` to emit `args "--resume" "/sessions/example.jsonl"`, or `resume: 'latest'` to emit `args "--continue"`. The `omp({ model, effort, resume })` helper accepts the same optional field. Omitted recovery intent starts a fresh conversation.

Use an exact transcript for managed seats when preserving a particular conversation; `latest` selects the newest session in the harness session directory. Paths are interpreted on the seat host and validated by the OMP launcher, not resolved by this generator. Recovery is a mutually exclusive typed choice, not free-form harness arguments. Applying a declaration does not itself authorize restarting a seat.
