# Nix/Devenv Troubleshooting

Common debugging steps for nix/devenv issues.

## Quick Diagnosis

```bash
# Check devenv status
devenv info --no-tui

# Check what inputs are being used
devenv info --no-tui 2>&1 | grep -A20 "Inputs:"

# Check devenv fingerprints - these determine cache hits/misses
devenv info --verbose --no-tui 2>&1 | grep -E "^attr_path:|Cache"
```

## Force a Clean State

If things are confused:

```bash
# 1. Clear devenv cache
rm -rf .devenv

# 2. Reload direnv
direnv reload

# 3. Verify
devenv info --no-tui
```

## devenv.yaml vs devenv.lock

- **devenv.yaml**: Source of truth for input URLs (committed to repo)
- **devenv.lock**: Resolved/pinned versions (committed to repo)

## Updating Inputs

```bash
# Update a specific input
devenv update <input-name>

# Update all inputs
devenv update
```

## Debugging Nix Evaluation

```bash
# See full evaluation trace
devenv info --verbose --no-tui 2>&1 | head -50

# Force re-evaluation (bypass cache)
devenv info --refresh-eval-cache --no-tui
```

## Related Documentation

See [requirements.md](./requirements.md) for nix-devenv requirements.
