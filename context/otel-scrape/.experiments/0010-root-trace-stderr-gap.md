# 0010 — root-trace stderr gap (baseline)

**Question:** On a root `otel-scrape` run with OTLP export configured, does
anything surface the minted trace id / a trace URL to the operator?

**Method:** Built the committed binary (`target/debug/otel-scrape`) and ran a
root command (no inbound `traceparent`) with stdout and stderr separated:

```
env -u TRACEPARENT -u traceparent \
  otel-scrape --otlp-endpoint http://127.0.0.1:4318 --service-name demo \
  -- sh -c 'echo child-stdout; echo child-stderr 1>&2'
```

**Result:**

- stdout: `child-stdout` (child only)
- stderr: `child-stderr` (child only)

Nothing about the minted trace id or a trace URL appears. The trace exists (root
minted in `trace_context_from_env`, `parent_span_id = None`) and is exported, but
the operator has no way to reach it except opening the backend UI and searching
by time window.

**Conclusion:** Confirms the gap R31 / decision 0020 address. The root trace id
is known to otel-scrape from the first instant of the run but never surfaced;
end-of-run terminal surfacing (bound to export success) closes it without
touching any sink.
