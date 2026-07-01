# Experiment 0005 — Command identity, span-name noise, and the trust boundary

**Hypothesis:** The `otel_scrape.command` span-name noise can be replaced with a
readable, privacy-safe command identity, and the current all-hashing privacy
default is stronger than the actual trust boundary requires.

**Method:** (1) Analysed a real dogfood trace (`632fcad3…`, a 138-span
`devenv check:all` run) captured in the dev-fleet Tempo backend, tabulating span
names and attributes. (2) Built the base-tip `otel-scrape` from an isolated
worktree (`nix build .#otel-scrape`) and wrapped real commands
(`echo`, `node --version`, `pnpm --version`, a nested `bash -c` script, and a
re-entrant `otel-scrape -- otel-scrape -- …`) against a local OTLP/HTTP JSON
capture server, inspecting every emitted attribute. (3) Read the source
(`packages/@overeng/otel-scrape/src/lib.rs`) for the identity/adapter/naming
levers. (4) Applied a throwaway 1-line patch (reverted) that names the command
span by the program basename. (5) Rendered a proposed-ideal design as a trace
and A/B'd it against the real trace in a local viewer.

**Results:**

- **Noise:** 76 of the 138 spans (55%) were generic `otel_scrape.command` /
  `otel_scrape.process` pairs — fixed span-name constants, `adapter.name = none`,
  `fidelity = degraded`, identity limited to `process.command_args_hash`
  (sha256) + `exit_code`. 35 of 38 command spans were parented by another
  `otel_scrape.command` (re-entrant wrapping). The only meaningful spans
  (`devenv.task.exec`, `typescript.project.check`) were buried under them.
- **Identity is hash-only by default:** the binary holds real argv internally
  (`config.argv`) but exports only `sha256(argv)`. Confirmed as a deliberate
  privacy rule (R27), not an oversight. No flag surfaces raw or basename
  identity; the span name is a locked constant (a test asserts it).
- **Basename is available and public-safe:** the throwaway patch produced
  `otel_scrape.command:echo` / `:node` / `:bash` with the args-hash unchanged —
  a readable identity with no raw argv exposure.
- **Adapters add events, not names:** the three shipped adapters
  (`none`, `oxlint`, `node-cpuprofile`) attach span events
  (`severity` + hashed filename; the diagnostic message is dropped) and profile
  links — they do not rename the span, add sub-spans, or add command identity.
- **The concrete-command level requires explicit wrapping:** a plain wrapped
  script's sub-commands get no spans; each concrete command gets its own span
  only when it is itself an `otel-scrape` invocation (re-entrancy via
  `TRACEPARENT`).
- **The process span is redundant in degraded mode** (same hash + exit as the
  command span) and carries distinct signal only under `ptrace-experimental`
  (`fidelity = exact`, a real descendant tree).
- **Trust boundary:** the fleet OTLP sink is a private, access-controlled
  backend; the summaries sink is written into a public source tree. So the
  public-safe rule is well-justified for summaries but stronger than needed for
  an operator-asserted private OTLP sink.

**Conclusion:** The design is coherent and validated:
[../.decisions/0014-command-identity-and-span-naming.md](../.decisions/0014-command-identity-and-span-naming.md)
— name spans by the operation (program basename), demote `otel-scrape` to
scope/attributes, merge the degraded process observation into the command span,
and relax R27 to public-safe-by-default with a per-sink trust assertion for raw
argv/cwd. The proposed-ideal render collapsed a `check:all`-shaped trace to
readable, fully-named spans while preserving the concrete-command level.
