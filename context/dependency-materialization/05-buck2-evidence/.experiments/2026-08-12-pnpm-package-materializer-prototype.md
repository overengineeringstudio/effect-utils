# pnpm package materializer prototype

Status: rejected and removed; input-plan discovery retained

## Question

Should the first TypeScript Buck slice include a repository-owned npm archive
normalizer, or stop at the exact lock-derived contextual input plan?

## Method

A TypeScript archive-normalizer prototype was built and its required semantics
surface enumerated against the exact lock-derived contextual input-plan join;
the implementation was deliberately not connected to a Buck action or consumer.
Method reconstructed from the record's context: the original record predates
the shape requirement and captured no separate method narrative beyond what the
result states.

## Result

The TypeScript prototype verified that archive normalization has a substantially
larger security and compatibility surface than the input-plan join: patches,
lifecycle scripts, links, PAX records, archive limits, path collisions, and
platform-specific optional packages all require explicit semantics and
fail-closed controls. The implementation was not connected to a Buck action or
consumer and therefore provided no action-cache or admission evidence.

Keeping that unused implementation would establish a second package-manager
surface before its ownership boundary was selected. It was removed together
with its public export and tests. The exact lock-derived contextual input-plan
discovery remains, including its relevant/unrelated mutation and fail-closed
resolver controls.

## Conclusion

The retained `tui-core` target is review evidence only. It does not fetch,
unpack, normalize, or materialize archives and cannot mint authoritative
package or task-closure identities. A future materializer must be introduced
through a real, bounded Buck action and tested against pnpm reference behavior
before admission; this experiment does not select its implementation language.

## VRS Impact

The dependency-closure spec now states the implemented boundary explicitly.
The normative materialization and admission requirements remain unchanged.
