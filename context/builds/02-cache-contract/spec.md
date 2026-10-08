# Cache Descriptor and Protocol Spec

This document specifies shared descriptor and client protocol semantics. It
builds on [requirements.md](./requirements.md).

## Status

Active.

## Scope

Owns schema, composition, naming and validation. Consumer profiles own trust
policy, credential admission and service topology. Execution owns lane hermeticity.

## Descriptor (BUILD.CACHE-R01–R04)

```text
producer JSON -> TypeScript + Nix validation -> composed descriptors -> client settings
```

The producer's tracked JSON is the single value source. TypeScript and Nix
readers import the same producer revision. The registry is the composed set of
exports, not a central second list.

```ts
type CacheDescriptor = {
  schemaVersion: 1
  name: string
  visibility: 'public' | 'private'
} & (
  | { kind: 'nix-binary'; uri: string; publicKey: string }
  | { kind: 'reapi'; uri: string; digest: 'SHA256'; cacheOnly: true; instanceName: string }
)
```

`kind` is the sole protocol discriminator; `visibility` is an independent trust
tier, not write authorization. All objects are exact-field. Both readers reject
missing/unknown fields, unsupported versions, invalid URIs, duplicate identities
and conflicting declarations. A descriptor grants neither reads nor writes.

`schemaVersion` is repository-local, not a wire-protocol version. Producers own
`name`: lowercase ASCII letters, digits and hyphens, unique in the composed
registry. Different descriptors claiming one name or two names claiming one URI
fail composition. Existing keys are never silently replaced. HTTPS and gRPC
retain their protocol owners; this schema registers no new URI scheme.

| Example                                                   | Result                                      |
| --------------------------------------------------------- | ------------------------------------------- |
| nix-binary + HTTPS uri + publicKey + public visibility    | Valid standard protocol shape               |
| reapi + grpc uri + SHA256 + cacheOnly true + instanceName | Valid REAPI shape                           |
| Same REAPI fields + private visibility                    | Valid private descriptor, not authorization |
| reapi + publicKey                                         | Invalid protocol fields                     |
| unknown kind/version, credential field, duplicate name    | Rejected                                    |

## RE Client Initialization

BUILD.CACHE-R05 constrains the lifecycle below.

The Buck [reuse client](../04-buck2/06-reuse-client/spec.md#client-contract) realizes
this protocol. Configuration must exist in `.buckconfig.local` **before the
Buck daemon starts**; `--config-file` and `--config` do not reach the RE client
([#1598](https://github.com/overengineeringstudio/effect-utils/pull/1598)). Changing
client posture requires stopping the daemon and starting with the new file and
environment. This is initialization ordering, not a credentials policy.

`engine_address` is required even for cache-only local execution.
`mkConsumerBuckRoot.engineAddress` defaults to null and resolves to
`actionCacheAddress`; callers may supply a distinct engine endpoint
([#1596](https://github.com/overengineeringstudio/effect-utils/pull/1596)).

## Open Design Questions

- **BUILD.CACHE-DQ01 Key rotation:** Blocked on an agreed producer key overlap and
  consumer freshness protocol; unsupported rotations fail rather than replacing keys.
