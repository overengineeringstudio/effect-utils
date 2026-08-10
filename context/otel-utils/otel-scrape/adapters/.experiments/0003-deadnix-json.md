# Experiment 0003 — deadnix --output-format json source

**Method:** deadnix 1.3.1 on throwaway `.nix` files with fabricated dead bindings
and lambda args. `-o json` / `--output-format json` (enum `[human-readable,
json]`). Read-only (never `--edit`).

**Result (sanitized, synthetic names):** NDJSON — one object per file,
newline-separated, not an array:

```
{"file":"sample.nix","results":[
  {"column":3,"endColumn":16,"line":2,"message":"Unused let binding: unusedBinding"},
  {"column":12,"endColumn":15,"line":4,"message":"Unused lambda argument: arg"}]}
{"file":"sample2.nix","results":[
  {"column":3,"endColumn":11,"line":3,"message":"Unused let binding: _ignored"}]}
```

A file with no dead code emits **zero bytes**. Exit code is 0 even with findings
(`--fail` flips it). No `severity`/`code`/`rule`/`kind` field exists.

**Conclusion:** declared, stable, needs-render — mirrors oxlint but thinner.
`message` carries the dead symbol's source name after `": "` (drop from sinks);
`endColumn − column` leaks identifier length (drop from sinks). Post-R27 OTLP
surface is N `"warning"` events (hashed file + line) + a `deadnix.findings`
count.
