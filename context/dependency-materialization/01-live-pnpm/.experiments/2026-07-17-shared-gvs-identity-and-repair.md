# 2026-07-17 Shared GVS Identity And Repair

## Question

Does sharing one pnpm Global Virtual Store across independently locked Effect 3
and Effect 4 roots make dependency identity install-order-dependent, and what
repair scope is required after a shared GVS edge is damaged?

## Method

- Installed an Effect 3 root containing `effect-distributed-lock` and an Effect
  4 root into one pnpm 11.3 GVS in both orders.
- Compared shared GVS with profile-isolated GVS and workspace-local virtual
  stores while retaining package-content reuse.
- Repeated the peer-context case with `react-redux@9.2.0` against React 18 and
  React 19.
- Reproduced the downstream name-only repair traversal separately.
- Removed a selected GVS edge and compared `pnpm install --force` with discard
  and rematerialization.
- Removed only the manual repair traversal in the real dotfiles/Vista workspace
  and reran precise typechecks.

## Result

- Native shared GVS passed both install orders. pnpm kept
  `effect-distributed-lock` linked to Effect 3.21.4 and retained distinct React
  peer contexts.
- The out-of-band name-only repair selected Effect 4.0.0-beta.97 and redirected
  peer consumers, producing the observed identity/type failures.
- A declared `packageExtensions` edge remained represented in lock state;
  synthesizing an undeclared filesystem link falsified dependency truth.
- `pnpm install --force` reused an incomplete GVS instance and did not restore
  its missing edge. Discarding the root projection and shared GVS `links/`, while
  retaining content-addressed package files, restored it.
- Removing the manual repair traversal kept the real shared-GVS install green,
  restored precise Vista/effect-utils typechecks, and completed the linked-repo
  install in 22.2 seconds.

## Conclusion

Shared GVS was not the cause of the Effect identity failure; the secondary
name-only graph writer was. The experiment did not show a correctness advantage
for local virtual stores in the tested normal-operation case. It did show that
shared GVS expands damaged-topology repair beyond one Materialization Root.

Root-local virtual topology was subsequently selected as the safety-biased
default for authority and repair containment, not because this experiment
proved it globally faster or smaller. That optimization claim remains pending a
direct topology-reuse comparison.

## VRS Impact

- Supports DMP.LIVE-R07 and DMP.STORE-R02 by proving pnpm must remain the sole
  Dependency Edge writer and repair must discard owned state.
- Supports decision 0006's bounded-authority rationale.
- Leaves DMP.VER-R12 open: shared, identity-partitioned, and root-local topology
  still need same-workload physical-byte and latency comparison.
