# Nix/Devenv Troubleshooting

Debugging guide for shell stability issues (R12) and other common nix/devenv problems.

## Shell Stability Issues (R12)

R12 requires that shell environments remain stable when nothing meaningful changed. If you're experiencing frequent shell rebuilds, use these steps to diagnose.

### Quick Diagnosis

```bash
# Check what version of tools you're getting
mr --version
genie --version

# Check devenv fingerprints - these determine cache hits/misses
devenv info --verbose --no-tui 2>&1 | grep -E "^attr_path:|Cache"

# Example output:
# attr_path: devenv, fingerprint: f5d7ff568986e9000a2a48136523611473120ce5
# attr_path: effect-utils, fingerprint: e8031be1dff9a39c3b58c376978e30f7a384bc30
# ...
# Cache hit
```

If you see "Cache hit", the shell is stable. If you see "Cached eval invalidated", something changed.

### Check Override URLs

The `.envrc.generated.megarepo` should use `git+file:...?ref=HEAD` URLs:

```bash
# Check the override args being passed to devenv
source .envrc.generated.megarepo
echo "${MEGAREPO_DEVENV_ARGS_ARRAY[@]}"

# Should show something like:
# --override-input effect-utils git+file:/path/to/repo?ref=HEAD
```

If the `?ref=HEAD` is missing, regenerate:

```bash
mr generate nix
```

### Common Causes of Instability

| Symptom                             | Cause                                            | Fix                                             |
| ----------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| Fingerprint changes on every reload | Using `path:` or `git+file:` without `?ref=HEAD` | Regenerate with `mr generate nix`               |
| Wrong tool version                  | `devenv.lock` pointing to old commit             | Update lock with `devenv update <input>`        |
| Override not applied                | Old `.envrc.generated.megarepo`                  | Delete and regenerate                           |
| Chicken-and-egg on new branch       | Lock files point to branch without fix           | Update `devenv.yaml` to point to correct branch |

### Verify the Override is Applied

```bash
# Check devenv sees the override
devenv info --verbose --no-tui 2>&1 | grep "effect-utils"

# Should show local path, not github:
# ├───effect-utils: git+file:/path/to/repo?ref=HEAD&rev=...
# NOT:
# ├───effect-utils: github:org/repo/...
```

### Check Lock File State

```bash
# Check devenv.lock
grep -A15 '"effect-utils"' devenv.lock | head -18

# The "locked" section shows what's actually used
# The "original" section shows the source definition
```

### Force a Clean State

If things are confused:

```bash
# 1. Clear devenv cache
rm -rf .devenv

# 2. Regenerate megarepo files
mr generate nix

# 3. Reload direnv
direnv reload

# 4. Verify
devenv info --verbose --no-tui 2>&1 | grep -E "^attr_path:|Cache"
```

## URL Schemes Comparison

| Scheme               | Tracks      | Dirty Changes | R12 Stable                           |
| -------------------- | ----------- | ------------- | ------------------------------------ |
| `path:`              | Timestamps  | Yes           | No - rebuilds on any file touch      |
| `git+file:`          | Tree hash   | Yes           | No - rebuilds on uncommitted changes |
| `git+file:?ref=HEAD` | HEAD commit | No            | Yes - only rebuilds on new commits   |
| `github:`            | Remote ref  | N/A           | Yes - but can't use local changes    |

The megarepo nix generator uses `git+file:?ref=HEAD` to balance local development (R8) with stability (R12).

## devenv.yaml vs devenv.lock

- **devenv.yaml**: Source of truth for input URLs (committed to repo)
- **devenv.lock**: Resolved/pinned versions (committed to repo)
- **--override-input**: Runtime override (from `.envrc.generated.megarepo`)

The override takes precedence, but only if properly passed to devenv commands.

## Debugging Nix Evaluation

```bash
# See full evaluation trace
devenv info --verbose --no-tui 2>&1 | head -50

# Check what inputs are being used
devenv info --no-tui 2>&1 | grep -A20 "Inputs:"

# Force re-evaluation (bypass cache)
devenv info --refresh-eval-cache --no-tui
```

## Related Requirements

See [requirements.md](./requirements.md) for the full list of nix-devenv requirements:

- **R8**: Build dirty/local changes without committing
- **R12**: Shell environments must remain stable
- **R21**: Devenv can override flake inputs for local development
