# Wave 0 peer-resolution finding

Identity: `org.schickling.eu.effect-4.wave0`

## Verdict

Wave 0 is not viable under the repository's strict peer-dependency contract.

`@overeng/react-inspector` proves only that an importer-local `effect` core version can coexist
with the repository's Effect 3 core. It does not prove that a package needing a still-separate
Effect ecosystem package can flip independently.

## Smallest reproduction: `@overeng/npm-release`

The faithful Effect 4 port requires:

- `effect@4.0.0-beta.102`
- `@effect/platform-node@4.0.0-beta.102`

The package-local catalog resolved its importer to the correct pair:

```yaml
'@effect/platform-node':
  specifier: 4.0.0-beta.102
  version: 4.0.0-beta.102(effect@4.0.0-beta.102)(ioredis@5.11.1)
effect:
  specifier: 4.0.0-beta.102
  version: 4.0.0-beta.102
```

The authoritative lock update nevertheless failed `ERR_PNPM_PEER_DEP_ISSUES` in both directions:

- Effect 3 workspace packages requiring `@effect/platform-node@^0.107.0` were checked against
  `@effect/platform-node@4.0.0-beta.102`.
- `@effect/platform-node@4.0.0-beta.102` requiring `effect@^4.0.0-beta.102` was checked against
  `effect@3.21.4`.

The root duplicate-exception mechanism validates resolved identities after lock generation; it
does not waive or partition pnpm's strict peer validation. Weakening `strictPeerDependencies` or
globally allowing cross-major peer ranges would remove the guardrail that detected the invalid
mixed cohort.

Changing this private package to direct-only / peer-free dependencies would be temporary
dependency-boundary scaffolding with a later revert obligation, so it was rejected.

## Remaining candidates

- `context/effect/socket` directly requires the still-separate
  `@effect/platform-node` package (and currently also `@effect/platform` / `@effect/rpc`).
- `context/opentui` directly requires the still-separate `@effect-atom/atom` and
  `@effect-atom/atom-react` packages; its generator also owns overrides for the v3
  `@effect/platform`, `@effect/experimental`, and `@effect/rpc` cohort.

Neither remaining candidate is core-only. Therefore no package in the proposed three-package
wave can flip independently.

## Integration constraint

The cohort flip must move `effect` core and every still-separate `@effect/*` / Effect ecosystem
package together in the same lockfile transition. A partial cohort cannot satisfy the repository's
strict peer contract.
