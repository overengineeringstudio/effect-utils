# 0011 — root-trace-surfacing live e2e (Grafana / Tempo)

**Question:** Does a root `otel-scrape` run surface a trace that is actually
reachable in the backend, and does the surfaced identity resolve to the same
trace end-to-end?

**Method (dev3, live OTEL stack — collector `127.0.0.1:4318`, Tempo, Grafana
`dev3:3700`):**

```
otel-scrape --otlp-endpoint http://127.0.0.1:4318 --service-name otel-scrape-verify \
  --trace-url-template 'https://dev3:3700/explore?traceql={traceId}' \
  -- sh -c 'echo hello-from-otel-scrape'
```

**Result — chain confirmed:**

1. Export returned 2xx, so the resolvable tier fired:
   `otel-scrape: trace:0449d244cd6bfd2e83fa9b846008bc52  https://dev3:3700/explore?traceql=0449d244cd6bfd2e83fa9b846008bc52`
2. The trace landed in Tempo (`gcx traces get -d tempo 0449d244…`): one command
   span named `sh`, scope `otel-scrape`, `process.exit.code = 0`, and the
   `otel_scrape.command.argv_hash` / `cwd_hash` / `process.observation.*`
   attributes — the expected merged direct-child command span.
3. A Grafana short link minted for the trace (`POST /api/short-urls`) →
   `http://dev3:3700/goto/ffqyxwomfzoxse`. `GET /goto/<uid>` returns `302` whose
   `Location` is the Explore URL carrying `query=0449d244…` — the `/goto/:uid`
   pattern resolves to exactly the surfaced trace.

**Conclusion:** The surfaced trace id is the queryable trace; the 2xx gate
correctly precedes a reachable trace (validating the acknowledged-export tier,
decision 0020 clause 2). The `/goto/:uid` short link is a good human/agent-facing
resolution path, but it is minted per-trace via the Grafana short-url API — it
cannot be a static `{traceId}` template, so the otel-scrape template stays the
long backend-agnostic Explore URL (decision 0020 clause 5); `/goto` short links
remain a downstream/fleet convenience, not a wrapper concern.
