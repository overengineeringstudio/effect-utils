# Buck2 Observability Roadmap

## Task-level PR report columns

The current [trace-access spec](./06-trace-access/spec.md) limits PR comments to
job facts from the GitHub Actions Jobs API. Task duration, action critical
path, and seven-run task baselines require a separate Tempo buck2 tenant and
an authenticated read proxy restricted to this repository's run/attempt and
allowlisted aggregates. The proxy must bind CI identity and must not accept
arbitrary TraceQL or caller-supplied tenant headers. Dotfiles owns the Tempo
writer/Grafana cutover and proxy access policy; this lane owns the report's
consumer contract. Revisit only after complete matching task spans from seven
successful main runs and safe read isolation have been measured
([decision 0004](./.decisions/0004-tempo-only-delivery-and-job-report.md)).
