# Experiment 0009 — sub-span re-parenting under an otel-scrape command span

Evidence for [decision 0018](../.decisions/0018-devenv-task-cooperation.md)
(clause 4). Question: when a concrete command is wrapped by otel-scrape inside a
task, do a task-parented sub-span emitter's spans (the devenv tsc phase-span
parser) re-parent UNDER the otel-scrape command span, giving
`devenv.task.exec → tsgo → typescript.project.check`?

## Method

Isolated `branchy fork` worktree (archived after; primary untouched).
`nix build .#otel-scrape`; store `otel-span`; export to dev3 Tempo. Reproduced the
real devenv nesting on a real `tsgo --build`: `otel-span devenv.task.exec -- bash
-c '<otel-scrape -- tsgo --build … --extendedDiagnostics --verbose>'`, with the
`tscWithDiagnostics` phase-span emit logic. Parentage read from the captured
trace with `gcx traces get -d tempo <id> -o json`.

## Findings

1. **Falsified.** In the faithful M4 path (trace `cd5972c1…`) the phase span's
   parent is the **task** span, not the `tsgo` (otel-scrape) span — they are
   siblings: `devenv.task.exec → { tsgo, typescript.project.check }`. Emitting
   from inside the otel-scrape child (trace `6741b6c1…`) did not change it — still
   sibling.
2. **Root cause.** The parser reads `${OTEL_TASK_TRACEPARENT:-${TRACEPARENT:-}}`
   (`ts.nix:168`, task var first — to survive devenv re-eval). otel-span exports
   BOTH `TRACEPARENT` and `OTEL_TASK_TRACEPARENT` = the task span. otel-scrape
   rewrites only `TRACEPARENT`/`traceparent` for its child (`lib.rs:845-846`),
   **never** `OTEL_TASK_TRACEPARENT`. So phase spans keep binding to the task.
3. **Fix proven.** Exporting the otel-scrape command-span context as
   `OTEL_TASK_TRACEPARENT` for the child (trace `ee161803…`) nests the phase span
   under the `tsgo` span (`35dba855…`) — correct
   `task → tsgo → typescript.project.check`. Preferred over "parser prefers
   TRACEPARENT" (which weakens the unwrapped re-eval path).

## Verdict

The naive claim is false; the minimal, general fix is clause 4 of decision 0018 —
otel-scrape MUST export `OTEL_TASK_TRACEPARENT` (alongside `TRACEPARENT`) for its
child so it is a well-behaved reparenting layer. This is a general R13
context-propagation correctness fix, relevant to any task-parented sub-span
emitter beneath an otel-scrape command, not just tsc.

Findings detail: `tmp/vista-issue866/m4-tsc-reparent-derisk.md` (gitignored).
Trace ids: sibling `cd5972c1…`/`6741b6c1…`, fixed nesting `ee161803…`.
