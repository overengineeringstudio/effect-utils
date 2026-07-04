# Experiment 0009 — sub-span re-parenting under an otel-scrape command span

Evidence for [decision 0018](../.decisions/0018-devenv-task-cooperation.md)
(clause 4). Question: when a concrete command is wrapped by otel-scrape inside a
task, do a task-parented sub-span emitter's spans (the devenv tsc phase-span
parser) re-parent UNDER the otel-scrape command span, giving
`devenv.task.exec → tsgo → typescript.project.check`?

## Method

Isolated scratch prototype worktree (archived after; primary untouched).
`nix build .#otel-scrape`; store `otel-span`; export to an internal Tempo backend. Reproduced the
real devenv nesting on a real `tsgo --build`: `otel-span devenv.task.exec -- bash
-c '<otel-scrape -- tsgo --build … --extendedDiagnostics --verbose>'`, with the
`tscWithDiagnostics` phase-span emit logic. Parentage read from the captured
trace fetched back from the Tempo backend by trace id.

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
3. **Nesting proven; naming is a separate axis.** Making the parser read
   otel-scrape's rewritten context nests the phase span under the command span
   (trace `ee161803…`, span `35dba855…`): `task → <cmd> → typescript.project.check`.
   That capture used Option 2 (parser prefers `TRACEPARENT`); its command span is
   named `bash`, because nesting requires parse+emit to run INSIDE otel-scrape's
   child — wrapping the whole `tscWithDiagnostics` body (child = `bash -c
'<body>'`). Wrapping only the compiler earns a `tsgo`-named span but leaves
   parse+emit in the task env → the falsified sibling case (S1). A
   `tsgo`-named-AND-nested span needs a span-name override not currently
   specified; name and nesting are separate axes.
4. **Chosen fix (0018) is the re-eval-safe equivalent.** Decision 0018 clause 4
   chooses Option 1 — otel-scrape EXPORTS `OTEL_TASK_TRACEPARENT` (its command-span
   context) for the child — achieving the same nesting as `ee161803` while leaving
   the parser's precedence (and unwrapped re-eval robustness) intact. Option 1's
   plumbing is reasoned from the root cause as equivalent to the `ee161803`
   capture, not separately captured.

## Verdict

The naive claim is false; the minimal, general fix is clause 4 of decision 0018 —
otel-scrape MUST export `OTEL_TASK_TRACEPARENT` (alongside `TRACEPARENT`) for its
child so it is a well-behaved reparenting layer. This is a general R13
context-propagation correctness fix, relevant to any task-parented sub-span
emitter beneath an otel-scrape command, not just tsc. For tsc specifically,
nesting the phase spans requires wrapping the whole body (command span named
`bash`); earning the `tsgo` identity instead means wrapping only the compiler
(phase spans stay task-siblings). Reconciling both needs a span-name override —
an implementation choice left to the epic worker.

Findings detail: `tmp/vista-issue866/m4-tsc-reparent-derisk.md` (gitignored).
Trace ids: sibling `cd5972c1…`/`6741b6c1…`, fixed nesting `ee161803…`.
