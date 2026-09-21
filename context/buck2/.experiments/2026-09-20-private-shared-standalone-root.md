# Private-shared standalone root and private pnpm consumer

Date: 2026-09-20
Host class: x86_64-linux development host (dev3), Nix sandbox enabled
Status: strict-green for the local substitution and consumer path

## Question

Can a repository outside effect-utils use the Nix-distributed Buck rule product
to build its own TypeScript products, restore those products through Nix
substitution, and give a private pnpm consumer the Nix-realized tarball without
putting a credential in the install?

## Method

1. Materialize a standalone private-shared Buck root from effect-utils'
   `buck2-rules` and capability outputs. The root contains no composed
   effect-utils Buck cell.
2. Build the `@overeng/geist-design-system` and `@overeng/meters` typecheck,
   emit, archive, and from-source Nix product graphs.
3. Copy both product store paths to a local `file://` binary cache. Restore them
   into an empty local Nix store from only that cache and compare NAR hashes.
4. Copy Vista blocks to an isolated staging tree. Replace its Geist workspace
   link in the staged manifest with the Nix-store tarball as a `file:`
   dependency. Install with scripts disabled, then run its TypeScript check and
   unit tests.
5. Add a main-only self-hosted publication job to private-shared. The job reads
   the Cachix credential from the runner netrc, pushes both store paths, and
   creates immutable digest-named pins only when they are absent. The local
   proof does not execute this credentialed job.

## Result

The standalone product graph was green for both packages. Each archive required
package materialization, typecheck, emit, and archive. The fresh committed-source
build took 30.3 seconds; the warm Nix no-op for both products took 0.343 seconds.

The products were:

| Product             | Store path                                                                                        | Restored NAR hash                                     |
| ------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Geist design system | `/nix/store/9ylac03svn1j6fcfw83nqp5f2s5bsjph-overeng-geist-design-system-buck2-from-source-0.1.0` | `sha256-1B9S0czkmAByp4wIgnqOsrRRulje8nBX8p3qEQaDfyA=` |
| Meters              | `/nix/store/khfjmv7xi901760ddr4wm0nbr4w7hlra-overeng-meters-buck2-from-source-0.1.0`              | `sha256-dTY0+Aye/XJLiyx/7bWiaC3lKPRZ1IqBMB/83VAZQlc=` |

The hashes matched before and after restoration from
`file:///srv/bulk/coding-agents/tmp/p2-cache`. No Cachix token was read.

The Geist archive SHA-256 was
`615d5f4a5799f1a2e11753686f7714595acf32d665e39f0fc6d1133004c48ef6`.
The staged pnpm lock resolved the package as a `file:` artifact under pnpm's
content-addressed package directory, not through the private-shared source
checkout. The archive supplied the declared source exports, including
`src/mod.ts` and `src/foundations/styles.css`. Vista blocks then passed
`tsc -p tsconfig.json` and its Vitest unit suite.

The isolated install exposed one existing undeclared direct import:
`react-aria`. The composed source workspace had supplied it incidentally. The
consumer PR declares `react-aria` directly and re-proves the source-workspace
TypeScript and unit-test baselines.

## Strict-green controls

- Removing the staged `react-aria` declaration made TypeScript reject the
  isolated consumer with `TS2307`; adding the direct dependency made it green.
- The installed Geist package resolved under pnpm's `file:` package path and
  retained the source exports required by Vista's StyleX transform.
- Both restored product paths had byte-identical NAR hashes to their source
  store paths.
- The publication job is main-only, derives `CACHIX_AUTH_TOKEN` without printing
  it, checks the existing pin list, and names new pins `<product>-<sha256>`.
  `actionlint` accepted the generated workflow after ignoring only the
  repository's declared custom runner-label diagnostics.

## Conclusion

Yes. A private pnpm consumer can install a Nix-realized product tarball through
a staged `file:` manifest without receiving a cache credential. Nix owns the
private substitution boundary; pnpm receives an ordinary local immutable file.
The product filename or store path must change with the product digest so the
lock cannot retain bytes from a mutable `file:` location.

This proof does not make an absolute Nix store path part of the checked-in
consumer manifest. The durable integration must realize the product first and
write the path only into the staged manifest. Source-workspace aliases may stay
for local co-development, but the staged typecheck and unit-test lane must not
resolve Geist through those aliases.

## VRS Impact

The 06 Nix bridge question about private pnpm consumption of Nix-realized
tarballs is resolved. Decision 0037's private `file:` route is implementable.
Requirements and vision remain unchanged.
