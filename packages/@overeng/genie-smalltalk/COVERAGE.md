# Smalltalk declaration coverage

Authoritative grammar: `compoundingtech/smalltalk`, `crates/st3/src/graph.rs` at the pinned st revision used by CI. This library validates authoring inputs; the st daemon remains the final parser and runtime authority. Constructor field names are TypeScript camelCase only where KDL uses hyphens.

| Grammar node                                                                                                                                  | Status      | Notes                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                                                                                                                                       | Partial     | All 19 ALLOWED child names modeled; complex `render`, `harness`, `pty`, `exec`, authority and restart forms are **not** fully represented; avoid assuming full parser parity.                                        |
| `mission`, `step`, `gate`, `exec`, `depends-on`, `schedule`, `work` | Partial | st `8298c70`: up to three goals; multiple unique gates; exists/empty/has/lacks and field is/starts-with/contains predicates; merged/ci-passed built-ins; exec gates with env/time-limit; multiple completed/failed/terminal step dependencies; retry attempts 1–100 and nonnegative backoff. Completion supports all-steps-exhausted or step-state frontiers; finally contains final-phase steps. Declarations, documents, human/LLM and aggregate gates remain unmodeled. |
| `loop`, `round`, `until`, `on-exhausted`, `attention` | Partial | Sequential max-rounds 1–100, optional until gates, explicit step-only round completion/finally, fail/succeed exhaustion and fail-only warning/error attention. Metrics, stop rules, keep/discard branches, nested loops and human exhaustion decisions are outside this stack's requested forms; removed for-each/candidate modes are deliberately not revived. |
| `resource`                                                                                                                                    | Partial     | Three resource kinds modeled; upstream accepts more kinds.                                                                                                                                                           |
| `account`, `pty`, `host`, `doc`, `lane`, `observer`, `subscription`, `person`, `mission-run`, `planning-session`, `message`, `repair`, `stop` | Not covered | Root grammar nodes omitted.                                                                                                                                                                                          |
| `version 2`                                                                                                                                   | Covered     | All emitted documents start with this directive.                                                                                                                                                                     |

The conformance test is opt-in with `ST_BIN` pointing to a binary built from the exact pinned upstream revision. Its scratch daemon must be isolated from the caller's runtime directories.

Harness authoring supports OMP model/effort and Codex optional model/effort/args. Codex `resume: { session }` lowers to `env.ST3_NATIVE_RESUME_SESSION`, binding the exact native thread; conflicting authored values are rejected. Omitted Codex model/effort preserve provider configuration defaults.

## OMP conversation recovery

OMP harness intent accepts `resume: { transcript: '/sessions/example.jsonl' }` to emit `args "--resume" "/sessions/example.jsonl"`, or `resume: 'latest'` to emit `args "--continue"`. The `omp({ model, effort, resume })` helper accepts the same optional field. Omitted recovery intent starts a fresh conversation.

Use an exact transcript for managed seats when preserving a particular conversation; `latest` selects the newest session in the harness session directory. Paths are interpreted on the seat host and validated by the OMP launcher, not resolved by this generator. Recovery is a mutually exclusive typed choice, not free-form harness arguments. Applying a declaration does not itself authorize restarting a seat.

The synthetic upstream-wait acceptance fixture preserves ordered steps and
full goals/constraints. With `ST_BIN`, its independent KDL is published, then its
typed equivalent is published to the same scratch daemon. `changed: false`
proves equality of st's normalized mission revision without executing its
fixture gates or starting the mission.
