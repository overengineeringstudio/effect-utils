# Experiment 0006 — vitest JSON reporter schema + span feasibility

**Method:** vitest 4.1.9, `--reporter=json --outputFile.json=<tmp>` on a throwaway
2-file / 2-suite / 7-test run (4 passed, 1 failed, 1 skipped, 1 todo). Also
inspected `dist/reporters.d.ts`.

**Result — the report is a post-hoc summary written once after the run, not a
stream.** Sanitized shape:

```jsonc
{
  "numTotalTestSuites": 5, "numFailedTestSuites": 3,
  "numTotalTests": 7, "numPassedTests": 4, "numFailedTests": 1,
  "numPendingTests": 1, "numTodoTests": 1,
  "startTime": <epoch-ms>, "success": false,
  "testResults": [
    { "name": "<path>/alpha.test.ts",
      "startTime": <epoch-ms-int>, "endTime": <epoch-ms-float>, "status": "failed",
      "assertionResults": [
        { "ancestorTitles": ["<suite>"], "fullName": "<suite> <case>", "title": "<case>",
          "status": "passed", "duration": 1.59, "failureMessages": [] },
        { "fullName": "<suite> <inner> <case>", "status": "failed", "duration": 5.53,
          "failureMessages": ["AssertionError: ...<stack with local paths redacted>"] } ] },
    { "name": "<path>/beta.test.ts", "startTime": <ms>, "endTime": <ms>, "status": "passed",
      "assertionResults": [ { "status": "skipped" } ] }   // skipped/todo have NO duration key
  ]
}
```

**Two structural facts drive the verdict:**
- Per-FILE has real `startTime`+`endTime` → a faithful lifecycle span (but `name`
  is an absolute path → hash-only identity).
- Per-TEST has `duration` but **no start timestamp**; `skipped`/`todo` have no
  `duration` at all → a per-test span would fabricate its start (R11/T02).

**Faithful per-test lifecycle** exists only in vitest's in-process reporter API
(`TestCase.diagnostic()` → `TestDiagnostic { startTime, duration, slow, heap,
retryCount, flaky }`) — a custom reporter emitting OTLP, i.e. the native
self-instrumentation lane (ADP-A01), not an otel-scrape adapter. No native OTEL
reporter ships in vitest 4.1.9 (grep clean).

**Conclusion:** metrics-only-honest. Broaden counts
(`passed`/`skipped`/`todo`/`suites`) and expose all counts as ADP-R06 command-span
attributes; do not reconstruct per-test spans from the file. `failureMessages`
(assertion text + stack + local paths) is render-only, never a sink.
