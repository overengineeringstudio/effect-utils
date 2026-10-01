# Open questions: Effect–Rust interop foundation

The implementation/admission work is tracked by [effect-utils#1549](https://github.com/overengineeringstudio/effect-utils/issues/1549). Only unresolved interop choices appear here; accepted choices and their history live in [.decisions](./.decisions/0006-package-identity.md), with numerical proof in [.experiments](./.experiments/b1-schema-compiler.md).

| Question                        | Resolution evidence                                                                                                                                                                                 | Spec                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Tag-first friction              | Realistic producer/tooling bakeoff: costs of ordering, rejected tag-last input, diagnostics, and loss of streaming paths under buffering. The accepted tag-first choice is pending this evidence.   | [DQ7](./spec.md#design-questions) |
| Cloudflare production memory    | Actual production peaks, memory-limit enforcement, GC/recycling, and repeated recovery with large touched linear memory. A temporary deployment experiment is authorized, not yet evidenced here.   | [DQ8](./spec.md#design-questions) |
| Optional mitigation measurement | Compare retire-time ArrayBuffer pressure hints and retired-bytes/rebuild budgets: peak/residue, latency, heuristic dependence, and availability. Isolate-scoped Layer placement is already decided. | [DQ9](./spec.md#design-questions) |

Package identity, compiler ownership, regex/vocabulary, generated Rust shape, JSON/full-width wire, binary bulk, Layer/API shape, and Buck architecture are decided. Local workerd reachability is resolved as delayed GC rather than foundation retention; production large-memory admission is not.

CLI bakeoffs belong to language policy, not this interop VRS. Neutral-IDL research remains separately tracked in [#1547](https://github.com/overengineeringstudio/effect-utils/issues/1547), outside this spec's scope; neither is an open interop question.
