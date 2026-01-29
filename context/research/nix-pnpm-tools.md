# Research: nix-update and pnpmConfigHook for effect-utils

## Question 1: Should we use nix-update for `dt nix:hash`?

### What nix-update does
[nix-update](https://github.com/Mic92/nix-update) automates **version bumps** for nixpkgs-style packages. It detects latest versions from GitHub/PyPI/crates.io, updates source hashes, and can update dependency hashes (cargoHash, npmDepsHash, etc.).

### Assessment: **No, it doesn't fit our use case.**

| Factor | nix-update | Our `dt nix:hash` |
|--------|-----------|-------------------|
| **Purpose** | Bump upstream package versions in nixpkgs | Update dependency hashes for our own packages |
| **Source model** | Fetches tarballs from GitHub releases | Uses local workspace source via `lib.cleanSourceWith` |
| **Hash updates** | Replaces `src.hash` + optionally `npmDepsHash` | Replaces `pnpmDepsHash` + `localDeps[].hash` |
| **Package format** | Expects nixpkgs-style `mkDerivation` with `version`/`src` | Our custom `mkPnpmCli` builder |
| **Iteration** | Single pass: version → hash | Multi-pass: iteratively fix N hashes until build succeeds |
| **Local deps** | No concept | Handles per-package `localDeps` with encoded dir names |

**Why it won't work:**
1. nix-update is designed for **upstream version bumps** (e.g., "update package X from v1.2 to v1.3"). We never fetch upstream sources — we build from our own workspace.
2. Our hash update logic is specific to our multi-package store merging approach. nix-update doesn't understand `localDeps[].hash` entries.
3. nix-update expects standard nixpkgs attribute paths. Our flake outputs don't follow that convention.
4. Our existing `dt nix:hash` already does exactly what we need, including pnpm offline install failure recovery (the `ERR_PNPM_NO_OFFLINE_TARBALL` detection added recently).

**Verdict:** nix-update solves a different problem. Our `dt nix:hash` task is purpose-built and more appropriate.

---

## Question 2: Using `pnpmConfigHook` in mk-pnpm-cli.nix

### Current approach
Our `mk-pnpm-cli.nix` manually:
1. Calls `fetchPnpmDeps` per package + per localDep
2. Merges stores with rsync into a combined tarball
3. Extracts the tarball, configures pnpm, runs `pnpm install --offline`

### What pnpmConfigHook does
`pnpmConfigHook` is a nixpkgs setup hook that automates step 3 — it extracts the fetched store and configures pnpm. It's the official companion to `fetchPnpmDeps`.

### Options

#### Option A: Keep current approach (status quo)
**How it works:** Manual store extraction + pnpm config in buildPhase.

**Pros:**
- Working and battle-tested
- Full control over store merging for multi-package builds
- Custom error recovery logic already in place

**Cons:**
- Reimplements what `pnpmConfigHook` does (~10 lines)
- Must track upstream changes to pnpm config knobs manually

**Risk:** Low. It works today.

---

#### Option B: Use pnpmConfigHook for single-package builds, keep manual for multi-package

**How it works:**
- When `localDeps = []`, use `pnpmConfigHook` instead of manual extraction
- When `localDeps` is non-empty, keep the manual rsync-merge approach

```nix
# For single-package case:
nativeBuildInputs = [ pkgs.pnpmConfigHook ... ];
pnpmDeps = mainDeps;  # pnpmConfigHook reads this automatically

# For multi-package case:
# Keep current manual approach
```

**Pros:**
- Aligns with nixpkgs conventions for the simple case
- Less custom code to maintain for single-package builds
- Automatically picks up upstream improvements to pnpm config

**Cons:**
- Two code paths → more complexity to test
- We currently have zero single-package CLIs (genie has 1 localDep, megarepo has 5)
- `pnpmConfigHook` may not set `package-import-method clone-or-copy` which we need for sandbox

**Risk:** Medium. Adds complexity for a case that doesn't currently exist.

---

#### Option C: Use pnpmConfigHook for all builds (refactor store merging)

**How it works:** Instead of merging stores ourselves, use `pnpmWorkspaces` parameter of `fetchPnpmDeps` to fetch all deps in one call.

```nix
pnpmDeps = pkgs.fetchPnpmDeps {
  pname = "${name}-pnpm-deps";
  src = workspaceSrc;  # Full workspace source
  hash = pnpmDepsHash; # Single hash for everything
  fetcherVersion = 3;
  pnpmWorkspaces = [ packageDir ] ++ (map (d: d.dir) localDeps);
};
```

Then use `pnpmConfigHook` which handles extraction automatically.

**Pros:**
- Single hash instead of N+1 hashes (1 main + N localDeps)
- Eliminates rsync store merging entirely
- Simpler `build.nix` files (no `localDeps` with per-dep hashes)
- Closer to upstream nixpkgs patterns
- `dt nix:hash` becomes simpler (one hash to update per package)

**Cons:**
- **Hash stability regression**: Currently, changing one localDep's lockfile only invalidates that dep's hash. With a single hash, any lockfile change invalidates the entire fetch.
- **Larger fetches**: Re-fetches all deps when any single lockfile changes, vs only the affected package.
- **Migration effort**: Need to update `build.nix` files, `nix-cli.nix` task, and test the `pnpmWorkspaces` parameter works with our per-package lockfile setup.
- **pnpmWorkspaces assumes monorepo lockfile**: Our packages have independent `pnpm-lock.yaml` files per package, not a root lockfile. This parameter may not work with our setup at all.

**Risk:** High. The `pnpmWorkspaces` parameter likely assumes a single root lockfile, which conflicts with our per-package lockfile design. Would require significant validation.

---

#### Option D: Use pnpmConfigHook but keep our store merging

**How it works:** Keep `fetchPnpmDeps` per-package + rsync merge, but let `pnpmConfigHook` handle the extraction/config step.

```nix
nativeBuildInputs = [ pkgs.pnpmConfigHook ... ];
pnpmDeps = combinedDeps;
# pnpmConfigHook extracts and configures automatically
```

Then remove our manual extraction code from buildPhase.

**Pros:**
- Keeps per-package hash granularity (no hash stability regression)
- Removes ~8 lines of manual store extraction/config
- Uses official hook for the "last mile"
- Minimal change to existing architecture

**Cons:**
- Need to verify `pnpmConfigHook` works with our combined tarball format (fetcherVersion 3 produces `pnpm-store.tar.zst` — same format we produce)
- Need to verify it sets `package-import-method clone-or-copy`
- Still need manual `pnpm install` per package dir (hook only does config, not install)
- May need to remove `pnpm config set` calls that conflict with hook

**Risk:** Low-Medium. Needs validation that hook's tarball extraction is compatible with our merged store format.

---

## Recommendation

**Option D is the best candidate** if we want to adopt official tooling. It's the smallest change with the highest alignment to upstream patterns, while preserving our per-package hash granularity.

However, **Option A (status quo) is also perfectly fine**. The manual code is ~8 lines and well-understood. The main benefit of switching is reduced maintenance burden if upstream changes pnpm config conventions.

### Validation steps for Option D
1. Check if `pnpmConfigHook` handles `pnpm-store.tar.zst` format (fetcherVersion 3)
2. Verify it sets `package-import-method clone-or-copy` (required for nix sandbox)
3. Test that our rsync-merged tarball is compatible with the hook's extraction
4. Confirm the hook doesn't run `pnpm install` automatically (we need per-directory installs)

### Not recommended
- **nix-update**: Wrong tool for the job (upstream version bumps, not local hash updates)
- **Option C**: High risk due to per-package lockfile incompatibility with `pnpmWorkspaces`
- **Option B**: Adds complexity for a case that doesn't exist

## Sources
- [nix-update](https://github.com/Mic92/nix-update)
- [nixpkgs pnpm support docs](https://github.com/NixOS/nixpkgs/blob/master/doc/languages-frameworks/javascript.section.md)
- [buildPnpmPackage discussion](https://github.com/NixOS/nixpkgs/issues/317927)
- [pnpm.fetchDeps fetcherVersion issue](https://github.com/nocodb/nocodb/issues/12276)
- [fetchPnpmDeps cross-compilation bug](https://github.com/NixOS/nixpkgs/issues/394625)
