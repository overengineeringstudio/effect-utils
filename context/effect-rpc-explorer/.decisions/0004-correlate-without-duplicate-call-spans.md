# 0004 - Correlate records without creating duplicate RPC spans

Status: accepted

## Context

The host's Effect RPC runtime already creates application call spans and
propagates request trace fields. The explorer must make records trace-navigable
without creating competing duration/status authorities or exposing content via
telemetry.

## Options

| Option                                                 | Result   | Reason                                                                  |
| ------------------------------------------------------ | -------- | ----------------------------------------------------------------------- |
| Explorer span per RPC call                             | Rejected | Duplicates Effect RPC duration/status authority and span volume.        |
| No trace association                                   | Rejected | Removes useful navigation from a record to existing application traces. |
| Copy trace fields; emit only rare pipeline-fault spans | Selected | Preserves correlation without competing with application telemetry.     |

## Decision

Copy observed trace fields into records, retain the host service identity, emit
no per-call explorer spans, and limit explorer telemetry to safe pipeline data.

## Evidence and Argument

Effect RPC already owns call spans and Requests carry trace fields. Copying
those fields preserves navigation; a second call span would duplicate status and
duration authority. Explorer pipeline faults are separate rare failures and can
be represented as root spans linked to the observed trace.

## Consequences

- Records copy observed trace ID, span ID, and sampled fields without fabricating
  context or changing parentage.
- The explorer creates no per-call spans and never creates a second service
  identity.
- Rare `rpc.explorer.pipeline.fault` spans use only closed-enum attributes and
  may link to a trace; they do not replace the application span.
- Metrics describe pipeline count, drops, active/retained state, normalization
  duration, and resets only; content, paths, request IDs, and RPC tags are
  prohibited.
