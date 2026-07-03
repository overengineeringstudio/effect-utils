# 0018 — devenv cooperation: task span owns the task level; otel-scrape wraps the concrete command

Status: accepted (boundary realigned by 0021)

> **Realignment (0021):** only the otel-scrape _tool-side_ of this cooperation is
> effect-utils' contract — join via `TRACEPARENT`, export `OTEL_TASK_TRACEPARENT`,
> own the command level, never own task semantics. _Which_ orchestration layer
> provides the task span — `otel-span` (interim) or native devenv tracing (target,
> dotfiles#1238) — is the fleet/architecture layer, owned by the dotfiles
> observability VRS, not this decision.

**Context:** The previous blanket task wrapper wrapped EVERY task phase in
`otel-scrape -- bash -c '<otel-span
devenv.task.exec … -- bash -c body>'`. That places a generic `otel-scrape`
command span (program=`bash`, adapter=none) ABOVE the real `devenv.task.exec`
span for the same execution — the redundant duplicate the Semantic Conventions
section forbids ("neither emits a second generic span for the same execution").
Decision 0014 (M1) only renamed it (`otel_scrape.command` → `bash`); the
structural duplicate remained. In a real `devenv check:all` trace this produced
one meaningless generic wrapper span per task. The concrete commands (`tsc`,
`oxlint`, `vitest`) ran as plain `bash -c '<cmd>'` INSIDE otel-span, so
otel-scrape never directly wrapped them and no adapter ever fired on the devenv
path (experiment `.experiments/0007-instrumentation-footprint.md`).

**Decision:** The task instrumentation owns the task level; `otel-scrape` owns
the concrete command level beneath it.

1. **Task level = otel-span only.** `trace.exec`/`trace.status` emit the
   `devenv.task.exec` / `devenv.task.status` span (via otel-span) and NO longer
   wrap the task shell in otel-scrape. The blanket task wrapper is removed.
2. **Concrete command = otel-scrape.** A task instruments a concrete command with
   a `trace.instr { adapter ? "none" }` helper that prepends an `otel-scrape`
   prefix to the command's real argv. This yields a named command span
   (`command.program`, argv/cwd hashes, exit, merged process) beneath the task
   span. It joins the task trace via the parent context otel-span exports (R06/
   R13). `adapter` is set only where the structured-source contract (0017) is
   met; otherwise `adapter=none` gives named-command identity without adapter
   records.
3. **Orchestration tasks stay task-level.** A task whose body is multi-command
   shell (e.g. genie coverage, lockfile checks) has no single concrete command
   and stays `devenv.task.exec`-only. Instrumentation is opt-in per task that
   runs a clean concrete command.
4. **otel-scrape exports `OTEL_TASK_TRACEPARENT` for its child.** For a
   task-parented sub-span emitter to re-parent beneath the otel-scrape command
   span, otel-scrape MUST export `OTEL_TASK_TRACEPARENT` (its own command-span
   context) to the child, alongside `TRACEPARENT`. Falsified-and-fixed by
   experiment `.experiments/0009-tsc-subspan-reparenting.md`: the devenv tsc
   phase-span parser reads `${OTEL_TASK_TRACEPARENT:-${TRACEPARENT:-}}` (task
   var first, to survive devenv re-evaluation), and otel-scrape today rewrites
   only `TRACEPARENT` — so phase spans stayed siblings of the `tsgo` span under
   the task, not children of it. Exporting `OTEL_TASK_TRACEPARENT` from the
   command span makes otel-scrape a well-behaved reparenting layer while leaving
   the parser's precedence (and its re-eval robustness) intact. This is a general
   context-propagation correctness fix (R13), not tsc-specific.
5. **Audit description, not rule.** The `devenv:trace-audit` task already
   enforces that every task routes through `trace.exec`/`trace.status`/
   `trace.withStatus` — i.e. every task has a task span. That rule stays correct;
   only its description updates (blanket otel-scrape task wrapper → otel-span task
   tracing plus opt-in concrete-command instrumentation).

**Consequences:**

- The generic per-task `bash`/`otel_scrape.command` wrapper is gone; a real
  `check:all` trace shows one task span per task, with named command spans only
  where a concrete command is instrumented.
- tsc/tsgo has no structured source (0017), so it is to be instrumented
  `adapter=none`. Two wrapping modes trade off (experiment 0009): wrapping only
  the compiler gives a `tsgo`-named command span with the phase-span scraper's
  `typescript.project.check` spans remaining task-siblings; wrapping the whole
  `tscWithDiagnostics` body nests those phase spans under the command span but
  names it `bash` (generic). Reconciling both (nested AND `tsgo`-named) needs a
  span-name override. Clause 4's `OTEL_TASK_TRACEPARENT` export is what makes the
  nested mode work at all. **Implemented (M25.2): wrap only the compiler** — the
  honest `tsgo` span name is preferred over nesting, so the phase spans stay
  task-siblings of `tsgo` (a real `check:all` trace confirmed
  `ts:check → { tsgo, typescript.project.check ×N, typescript.build.aggregate }`).
- oxlint and vitest are to be instrumented with real adapters (0017): oxlint with
  `--format=json` + pretty-out, vitest via the `--reporter=json` side-channel
  (interactive output preserved).
- Implementation follows the task/command ownership split above.

**Options considered:**

| Option                                                                 | Consequence                                                                            | Verdict                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Keep blanket task wrapper                                              | one generic `bash` span per task above the real task span; adapters never fire; noise. | rejected — the reported problem.                                    |
| Suppression protocol (otel-scrape hides its span at the task boundary) | machinery to make a no-op invisible.                                                   | rejected — if it adds nothing at a layer, remove it, don't hide it. |
| otel-scrape replaces otel-span at the task level                       | otel-scrape does not own task semantics (`task.name`/`task.cached`).                   | rejected — fights the ownership split.                              |
| Task span (otel-span) outer, otel-scrape wraps the concrete command    | clean nesting, adapters fire where structured-source exists, concise call-site.        | accepted                                                            |

Grounded by `.experiments/0007-instrumentation-footprint.md` and
`.experiments/0009-tsc-subspan-reparenting.md`. Depends on
[.decisions/0017-adapter-structured-source-and-presentation.md](./0017-adapter-structured-source-and-presentation.md);
extends the cooperation invariant in
[.decisions/0014-command-identity-and-span-naming.md](./0014-command-identity-and-span-naming.md).
