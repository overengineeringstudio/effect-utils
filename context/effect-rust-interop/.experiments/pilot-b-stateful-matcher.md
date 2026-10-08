# Experiment: internal app pilot B (stateful matcher)

Non-normative historical evidence preceding the resource and typed-direct follow-ups. Public summary evidence is not a claim that the private application has been migrated to those later PRs.

## Question

Can generated stateful contracts preserve behavior/lifetime without imposing unacceptable warm-call overhead?

## Hypothesis

A Rust-owned stateful contract can preserve matcher behavior and scoped lifetime, while a generated JSON/Effect boundary may impose material overhead even with codecs hoisted.

## Method

The published pilot summary compares raw bindings with the generated JSON/Effect boundary on warm matcher calls, runs parity vectors, and cycles resource creation/drop. The supplied q51 request identifies a pilot-local resource generator because free functions and byte streams did not cover the required scoped matcher object. Detailed sampling and whole-process memory methodology are not present in the public summary and are not inferred here.

## Result

| Historical pilot observation        | Result                                         |
| ----------------------------------- | ---------------------------------------------- |
| Behavior parity                     | 41/41                                          |
| Resource stress                     | 10,000 create/drop cycles; zero leaks reported |
| Generated boundary versus raw, Bun  | 3.2× slower                                    |
| Generated boundary versus raw, Node | 5.4× slower                                    |
| Warm call scale                     | Approximately 20–45 µs; codecs already hoisted |

The leak result is a reported scoped-resource observation, not proof of arbitrary heap/RSS reclamation, poisoned-instance cleanup, or production workerd memory admission.

The subsequently built [resource PR #1605](https://github.com/overengineeringstudio/effect-utils/pull/1605) exercises generated counter resources, not this matcher: ordered concurrent mutation, expected errors, exactly-once Drop on healthy close, idempotent close, 1,000 create/drop cycles per Node/Bun runtime and transport, sibling poisoning, stale rejection, and fresh acquisition after rebuild. A separate runtime stress records zero live handles/jobs after 1,000 scoped releases. Wasm trap retirement still cannot promise Rust Drop.

The later [typed-direct benchmark](./q53-direct-transport.md) tests unchanged fixture workloads before/after #1610. It reproduces domain overhead of 3.23–4.16× wasm and 3.30–3.89× native before its change, then measures the direct path. Those are separate baselines, not a rerun of the 3.2×/5.4× matcher measurement.

## Conclusion

The pilot supports the need for scoped stateful exports and shows that codec hoisting alone did not eliminate hot-call overhead. It does not justify bypassing validation. The later resource and direct-transport changes supply built follow-up evidence without retroactively changing the historical matcher result.

## Intent Impact

Add scoped resource exports and investigate direct validated transport; do not recommend bypassing the contract or equate resource counters with prompt memory reclamation.

## Limits

The upstream summary still describes resource/direct work as planned. #1605 and #1610 subsequently contain exercised implementations but were open, not merged, when consulted. The pilot's 10,000 cycles and #1605's 1,000 cycles have different products and denominators; neither replaces [workerd release-latency evidence](./w-workerd-memory.md).

## Sources

- [Public interop review evidence table](https://github.com/Effect-TS/effect/issues/8690), for parity, lifecycle, and pre-direct overhead.
- Supplied private q51/q53 requests, for the pilot-local resource gap and hoisted-codec context, summarized without private identities or filesystem locations.
- [Scoped resource PR #1605](https://github.com/overengineeringstudio/effect-utils/pull/1605) and [typed direct PR #1610](https://github.com/overengineeringstudio/effect-utils/pull/1610).
