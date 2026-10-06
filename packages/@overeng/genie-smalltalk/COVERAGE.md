# Smalltalk declaration coverage

Authoritative grammar: `compoundingtech/smalltalk`, `crates/st3/src/graph.rs` at the pinned st revision used by CI. This library validates authoring inputs; the st daemon remains the final parser and runtime authority. Constructor field names are TypeScript camelCase only where KDL uses hyphens.

| Grammar node                                                                                               | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent`                                                                                                    | Partial     | All 19 ALLOWED child names modeled; complex `render`, `harness`, `pty`, `exec`, authority and restart forms are **not** fully represented; avoid assuming full parser parity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mission`, `step`, `gate`, `exec`, `depends-on`, `schedule`, `work`                                        | Partial     | st `8298c70`: up to three goals; multiple unique gates; exists/empty/has/lacks and field is/starts-with/contains predicates; merged/ci-passed built-ins; exec gates with env/time-limit; native human gates with person reviewer, optional approve/feedback mode, question and unique repeated review targets; multiple completed/failed/terminal step dependencies; retry attempts 1–100 and nonnegative backoff. Completion supports all-steps-exhausted or step-state frontiers; finally contains final-phase steps. Immutable step documents and named/pinned document gates are modeled. LLM/aggregate gates, cargo-test, graph-predicate dependencies, inputs, revision policy, produced/used/nested missions and additional worker selectors remain outside this stack. |
| `loop`, `round`, `until`, `on-exhausted`, `attention`                                                      | Partial     | Sequential max-rounds 1–100, optional until gates, explicit step-only round completion/finally, fail/succeed exhaustion and fail-only warning/error attention. Metrics, stop rules, keep/discard branches, nested loops and human exhaustion decisions are outside this stack's requested forms; removed for-each/candidate modes are deliberately not revived.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `resource`                                                                                                 | Partial     | vcs.repository, filesystem.file, vcs.pull-request and vcs.ref. Additional resource kinds are outside the requested ref-watch forms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `doc`, `observer`, `subscription`                                                                          | Partial     | Doc hash bindings; github.ref observers with nonempty OWNER/REPO@REF locators (slash-containing refs supported), unique head/ancestors fields and optional every; message subscriptions with unique on fields and optional field conditions. Constructors also work as declarations on missions, steps and loop rounds. st owns runtime ID scoping and alias rewriting. Other providers, subscription mission/watch/batched delivery, quantified subscription conditions, mention routing and stop declarations are outside the requested vcs.ref/github.ref message-watch forms.                                                                                                                                                                                              |
| `account`, `pty`, `host`, `lane`, `person`, `mission-run`, `planning-session`, `message`, `repair`, `stop` | Not covered | Additional root grammar is unrelated to the requested mission extension.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `version 2`                                                                                                | Covered     | All emitted documents start with this directive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

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

With `ST_BIN`, conformance stores real immutable document bytes, publishes pinned
step references and document gates, and starts a held ref-watch mission. It
observes run-scoped observer/subscription subjects and the rewritten observer
reference in the subscription, without depending on live GitHub observations.

## Step handles

`step({ id: 'review', missionId: 'landing', assignedTo: { kind: 'agent', id: 'team/worker' } })`
returns a renderable `StepHandle<'landing'>`. `completed(handle)`, `failed(handle)`
and `terminal(handle)` lower to the existing dependency grammar. A literal
`missionId` makes foreign scopes a TypeScript error; omitting it preserves
unscoped plain-data authoring. Assembly always checks exact dependency handle
membership within the same phase and rejects handles already owned by another
mission, including foreign handles with colliding IDs.

The resolved `AgentRef` contains `{ kind: 'agent', id }`. The URL-only tree
reference in #1628 requires its loader's root to resolve an ID, so it is not
silently interpreted as a global subject. Resolve it through the tree loader
before using this standalone constructor.

## Native gates

`humanGate`, `execGate`, `fieldIs`, `merged` and `ciPassed` return plain gate data
accepted by mission/step gates, including step handles. Human gates lower to
`gate "NAME" type="human"` with repeated `review` children, not an exec wrapper.
st owns approval requests and decisions. With `ST_BIN`, conformance starts a
human-gated mission and checks the reviewer's actual attention inbox, and publishes
a handle with each mechanical constructor without executing network-dependent
GitHub checks.
Feedback mode is restricted to worker step gates: mission gates, loop-until
gates and agentless step gates reject it with the native parser's placement errors.
