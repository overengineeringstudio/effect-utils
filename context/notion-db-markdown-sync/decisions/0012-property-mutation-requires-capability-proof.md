# Property mutation requires capability proof

Status: accepted

Datasource page files may remain standalone NotionMD files without forcing
standalone NotionMD to categorically reject datasource property writes. The
guard should be semantic: a property mutation is allowed only when the caller can
prove property identity, schema freshness, relation target availability, and
local-surface convergence for the affected property.

The shared property-write core should depend on canonical property schemas,
canonical values, write payload codecs, property identity brands, and
write-class taxonomy from `@overeng/notion-effect-schema`. That package owns
schema/value/codec/classification facts. It must not own authority modes,
workspace convergence, outbox, conflicts, or live proof acquisition.

## Considered Options

| Option                                              | Result      | Reason                                                                                                                              |
| --------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Reject datasource properties in standalone NotionMD | Rejected    | Safe but too blunt; it prevents coherent composition when enough proof exists.                                                      |
| Trust embedded property IDs in `.nmd` files         | Rejected    | Property IDs alone do not prove fresh schema, rename/collision safety, relation availability, or absence of data-file disagreement. |
| Require a property mutation proof                   | Recommended | The same guard can be used by standalone NotionMD and datasource-sync, and failures identify the missing invariant.                 |
| Put sync proof in `@overeng/notion-effect-schema`   | Rejected    | The schema package should own property semantics, not live evidence, authority modes, or workspace state.                           |

## Consequences

Standalone NotionMD may mutate datasource-scoped properties only when invoked
with, or able to derive, a datasource property-mutation proof. Otherwise it fails
closed with a guard such as `RemoteSchemaRequired`,
`PropertyIdentityAmbiguous`, `RelationTargetsUnavailable`,
`LocalSurfaceDisagreement`, or `StaleRemoteSchema`.

`.nmd` files may carry compact non-authoritative property descriptors such as
property ID, property name, property type, data-source ID, and config hash. These
descriptors are one evidence source for which property the file claims to edit,
not a required proof carrier and not proof that the edit is currently safe.
Fresh schema reads or datasource workspace context remain required for write
safety.
