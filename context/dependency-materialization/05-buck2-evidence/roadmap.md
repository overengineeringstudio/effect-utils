# Buck2 Evidence Roadmap

## Shared Launcher Graduation

Use effect-utils as the default initial owner, but compare it with a downstream
system repository before wider implementation. Immediate consumer-local or
shared placement is allowed when current evidence shows materially better
dependency direction, bootstrap behavior, public/private isolation, reuse, or
rollout economics. Otherwise keep it in effect-utils through the first target,
cache, artifact-import, and observability rollout and reconsider after another
megarepo demonstrates the same stable launcher protocol.

## Closure Refinement

Implement the final role-aware closure schema immediately. The first shadow
target may use a visibly conservative full-importer closure to isolate resolver,
projection, artifact-import, and observability proof. Refine it into runtime,
check, test, and tool closures where measured closure size, transfer,
materialization, or invalidation savings are material; otherwise retain a
documented no-benefit result rather than multiplying equivalent targets.

## Generated Graph Layout

Generate deterministic checked-in `BUCK` and closure descriptor shards at
package ownership boundaries through Genie. Keep reusable providers and rule
implementations hand-authored in shared `.bzl` modules. A package change must
not rewrite unrelated package shards; a whole-repository graph export is
evidence/output, not common analysis input.

## Toolchain Bridge

Keep tool recipes and pins in Nix. Export simple tools as verified relocatable
per-platform archives consumed by Buck toolchain providers; use Nix-built
execution images for native closures that cannot be made simply relocatable.
Raw store paths are local evidence-only bootstrap inputs and cannot participate
in authoritative cache writes.
