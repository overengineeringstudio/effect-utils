# Action-level reuse across changed-closure Nix product builds

Date: 2026-10-05
Host class: x86_64-linux development host, Nix sandbox enabled, pinned Buck
Source: InNixReuse report; controlled one-crate Rust product experiment

## Question

Can action-level reuse across changed source closures preserve the pure
sandboxed product recipe, and does the measured end-to-end saving justify
adopting it?

## Hypothesis

A changed product source closure can reuse unchanged Buck dependency actions
inside an ordinary pure Nix sandbox without making an action cache the product
origin. This probes [DQ1](../spec.md#open-design-questions) under
[decision 0037](../../../.decisions/0037-nix-substitution-is-the-distribution-layer.md).

## Method

The report compares a cold sandbox build with two fresh-sandbox builds of the
same changed source: one restores only `buck-out` with the cache disabled; the
other imports an offline AC/CAS capsule and serves REAPI on sandbox-local
loopback. Cache misses execute locally. There is no host-network exception,
credential in the derivation, remote execution, or shared-cache mutation.

The controlled change appends a source comment to the application crate. It
changes the compiler input, but is not a committed product-revision update or a
provenance-valid release. The source, root/capabilities, release configuration
and Buck isolation namespace are aligned. Timings exclude admission queue time;
Buck-native event counters establish execution classes rather than wall-clock
inference. Remote Nix builders are disabled.

A separate direct-Buck smoke stages the same declared inputs outside Nix, warms
its scratch cache/work directory, resets its daemon, changes the same crate,
and imports the resulting archive/descriptor/provenance directory with
`nix store add-path`. No publisher or registry is changed.

## Result

| Variant                                                 |           Build section |                                        Command wall time | Buck command outcome                                     |
| ------------------------------------------------------- | ----------------------: | -------------------------------------------------------: | -------------------------------------------------------- |
| Cold sandbox, populating private scratch AC/CAS         |                   237 s | Approximately 420 s; exact Nix command wall not retained | 0 cache hits; 1406 local                                 |
| Changed source, restored `buck-out`, cache disabled (C) |                   185 s |                                           Nix: 234.048 s | 0 cache hits; 1406 local                                 |
| Changed source, offline REAPI capsule in sandbox (E)    |                    79 s |                                           Nix: 208.582 s | 1404/1406 cache hits; 2 local                            |
| Changed source, direct Buck plus local CA import (D)    | Not separately recorded | Buck: 136 s; CA import below one-second timer resolution | 2 local; 1404 dependency actions reused from local state |

E reduces the build section by **57.3%** relative to C (185 → 79 s), but the
actual Nix command by only **10.9%** (234.048 → 208.582 s, approximately
234 → 209 s). The whole-product prototype copies/exports approximately
**0.7 GB of cache plus 1.2 GB of `buck-out`** (690,777 KiB and 1,179,378 KiB
on disk). Its build-section timer excludes that state transport; end-to-end
wall time is the meaningful comparison. C performs no action reuse at this pin.

Both changed sandbox builds and the changed direct build have archive SHA-256
`c0a04ac2b20898d904145f17ea19f21b02b923046dfa12d56651691cc2012168`.
The report also observes a successful `--help` smoke from the CA-imported
archive. The imported path has a fixed recursive content address, no references,
no deriver and no signatures: local CA import is not signed publication.

The direct run reuses its work directory and materializes 546 MiB; its 1404
reused dependency actions are not 1404 new REAPI lookups. The **136 s** result
is a mechanism smoke, not a clean speed ranking against fresh sandboxes.

## Options and Verdicts

| Option | Mechanism                                                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A      | Align filtered-source Nix derivations with stable Buck targets; explicitly consume prebuilt providers or capsules | Not chosen. Pure substitution fits, but generic Rust providers/action-DAG projection add substantial compiler, feature and build-script boundary machinery. Invoking a library in a separate derivation alone does not create reuse. Buck must remain the only graph authority.                                                                 |
| B      | Read a live REAPI cache from the sandbox                                                                          | Not chosen. Blanket sandbox relaxation and `__impure` do not preserve the ordinary pure product contract; recursive Nix is not REAPI transport. A narrow read-only socket broker or known-digest FOD needs explicit transport, trust and failure handling; neither is proved here. Read-only access does not establish action-writer integrity. |
| C      | Restore a declared previous `buck-out` output                                                                     | Fails at the measured pin: 0 hits and all 1406 commands execute. Copying materializer state is not a persistent action cache; Nix content addressing does not supply Buck action reuse. Implicit previous-product lookup and unbounded history chains are not acceptable substitutes.                                                           |
| D      | Direct pinned Buck release build, then verified content-addressed Nix import and protected publication            | Mechanism and controlled archive equality observed; not chosen. Requires an explicit 0037 amendment, an audited hermetic protected publisher and a verified CA identity/registry/reconstruction contract. Edit-loop permission does not authorize outside-Nix publication.                                                                      |
| E      | Substitute a reconstructible offline AC/CAS capsule and serve it inside the sandbox                               | Linux action reuse works: 1404/1406 hits. Not chosen for adoption: only 10.9% end-to-end gain from the heavyweight prototype. Slim graph-derived dependency-only capsules and Darwin transport remain unproved.                                                                                                                                 |

For E, a production alternative would exclude `buck-out`, daemon state and
measurement logs; version compatibility and normalize incidental cache metadata;
explicitly publish build-only capsule outputs; and bound size/retention.
Cold sandbox reconstruction, seed/no-seed digest equality and cold fallback on
local-server/RPC/CAS failure remain necessary. The prototype proves healthy
Linux hits/misses, not fault recovery. Darwin transport needs a demonstrated
build-directory Unix socket path or a separate explicit local-networking
permission decision; Linux loopback success grants no Darwin exception.

## False-touch Evidence

The dotfiles frozen first-parent replay covers 539 commits over the inclusive
2026-09-28–2026-10-05 window and the top ten products. Closure precision
[#4743](https://github.com/schickling/dotfiles/pull/4743) and dependency
projections [#4760](https://github.com/schickling/dotfiles/pull/4760) reduce
product-touch opportunities **604 → 554 → 462**. The pending telemetry-only
cutover [#4798](https://github.com/schickling/dotfiles/pull/4798) reports a further
counterfactual **462 → 371**, not an achieved cutover.

These are replay opportunities, not actual builds, cache-hit rates or saved
build seconds. The window spans eight calendar dates, with the last partial;
weekly normalization is count × 7/8: **528.50 → 484.75 → 404.25**, and
**324.625** for the pending cutover. Genuine source changes still invalidate
their application and reverse-dependency actions.

## Conclusion

The report recommends exploring slim E capsules, with D as the alternative
trust-model change. Johannes' current answer is instead to **keep pure sandboxed
Nix product builds, record the evidence, and revisit only if the daily
cache-health mission shows changed-product rebuild cost dominating**.

## Intent Impact

[The owning open question](../open-questions.md#dq1-action-level-reuse-across-changed-closure-product-builds)
records that answer and its alternatives. The experiment does not amend 0037,
change a protected requirement, authorize an offline capsule rollout or an
outside-Nix publisher, or turn an action cache into a durable product origin.
