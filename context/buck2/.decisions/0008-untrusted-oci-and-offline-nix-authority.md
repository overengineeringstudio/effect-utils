# 0008 Untrusted OCI Transport and Offline Nix Authority

Status: accepted

## Context

Buck products need efficient self-hosted distribution across machines without
turning registry state into deployment authority or merging Buck, OCI, and Nix
cache semantics. Mutable tags, OCI index platform matching, referrer discovery,
replication status, and a second registry copy each leave distinct integrity or
durability gaps.

## Evidence and Argument

A local OCI-distribution prototype preserved generic artifact bytes under
digest push and pull, represented a multi-platform index, discovered referrers,
survived restart, and fed a Nix fixed-output import. It also confirmed that tags
remain mutable and that successful replication or discovery does not prove the
complete graph was independently readable. OCI platform metadata does not
encode the product's full runtime ABI, so automatic index selection cannot
replace the product descriptor.

Using reviewed Nix expectations at import retains the existing system authority
and permits network-free activation and rollback. A sealed root avoids treating
an eventually consistent referrer listing as evidence completeness. Two
independent reads detect a broken primary or replica, while a third encrypted
failure-domain archive with an actual restore distinguishes backup from another
online copy.

## Options

| Dimension             | Accepted option                                         | Rejected alternative and reason                          |
| --------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Transport authority   | OCI is untrusted digest-addressed storage               | Registry/tag authority is mutable and operational        |
| Platform selection    | Reviewed exact child-manifest Nix pin                   | OCI-index auto-selection omits complete runtime ABI      |
| Evidence completeness | Sealed admission-bundle root                            | Referrer discovery cannot prove a closed required set    |
| Durability            | Two independent reads plus third restore-tested archive | Replica-only design shares failure and deletion risks    |
| Lifecycle             | Network only in fixed-output import                     | Networked activation makes rollback depend on transport  |
| Collection            | Disabled until pin-derived, previewed, restorable GC    | Tag/age-based deletion can remove admitted rollback data |

## Decision

Publish products and evidence as digest-addressed OCI graphs, but treat every
registry as replaceable untrusted transport. Reviewed Nix configuration pins the
exact platform child manifest and sealed admission bundle, and the importer
verifies those expectations before extraction. Production admission requires
independent verification from two storage instances, a verified restore from a
third encrypted failure-domain archive, and network-disabled activation and
rollback. Garbage collection is a separately admitted destructive capability.

Buck REAPI, OCI product distribution, and the Nix binary cache/store remain
three independent reuse planes with separate identities, credentials,
retention, observability, and verdicts.

## Consequences

- Mutable tags and OCI indexes remain useful discovery surfaces but never pins.
- Registry outages do not affect an already imported generation.
- A registry replica is not called a backup without an independent restore.
- Public contracts contain no fleet topology, endpoints, or credentials.
- Collection begins conservatively with deletion disabled.
