# Experiment 0001 — oxlint --format=json source (reference)

## Question

What structured telemetry or fidelity evidence does the Experiment 0001 — oxlint --format=json source (reference) probe provide?

## Method

oxlint 1.39.0 on a throwaway `.ts` with a `debugger` statement and an
unused function. Formats offered: checkstyle, default, github, gitlab, json,
junit, stylish, unix — **no SARIF**.

## Result

```json
{
  "diagnostics": [
    {
      "message": "`debugger` statement is not allowed",
      "code": "eslint(no-debugger)",
      "severity": "error",
      "filename": "sample.ts",
      "labels": [{ "span": { "line": 2, "column": 3 } }]
    },
    {
      "message": "Function 'demo' is declared but never used.",
      "code": "eslint(no-unused-vars)",
      "severity": "warning",
      "filename": "sample.ts",
      "labels": [{ "span": { "line": 1, "column": 10 } }]
    }
  ],
  "number_of_files": 1,
  "number_of_rules": 90,
  "threads_count": 32,
  "start_time": 0.023553108
}
```

## Conclusion

declared, stable, needs-render (replaces human stdout). Both
`severity` values confirmed. No `fixable`/`fix` field. Maps to two events
`{severity, filename_hash, rule, line}` + count `oxlint.diagnostics`.
`message`/`filename`/`help`/`url` dropped from all sinks. gitlab's per-diagnostic
`fingerprint` is the only cross-run-identity signal any format adds (unused now).

## Intent Impact

The recorded evidence informs the owning requirements without changing their
protected fidelity, public-safe output, or authority boundaries.
