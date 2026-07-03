# Experiment 0005 — oxfmt / nixfmt have no adapter-grade source

**Method:** oxfmt 0.45.0 and nixfmt 1.3.1 (nixfmt-rfc-style) on throwaway files.
Read-only (`--check` / `--list-different`); never wrote repo files.

**oxfmt result:**

- No first-class OTEL; no `--format`/`--reporter`/`--json`.
- `--check` prints human prose (`bad.ts (0ms)` … `Format issues found in above N
files` … `Finished in Yms on M files`). `--list-different` prints a newline-
  separated path list (no trailing `\n`). The two are **mutually exclusive**, so
  no mode yields a clean `(files_checked + files_unformatted)` structured source.
  No side-channel. Exit: 0 formatted / 1 diffs / **2 error/no files matched**.
- Public-safe residue after R27 drops all paths = one count, already implied by
  the exit code.

**nixfmt result:**

- No first-class OTEL; no JSON/`--format`/machine-list flag.
- `--check` = exit code + human stderr `"<path>: not formatted"`; `--check
--quiet` = pure pass/fail (streams empty). Syntax errors dump a Megaparsec
  caret block **including source text** on stderr (never-emit).

**Conclusion:** both are pass/fail `--check` tools. Parsing their human output is
R08-barred; the only public-safe fact is a count already implied by the exit
code, and surfacing it would incur the R30 re-presentation obligation. Verdict:
**no adapter** — wrap with `adapter = "none"` (ADP-A02) for a timed pass/fail
command span. Same bucket the parent source audit assigned tsc/vite/storybook.
