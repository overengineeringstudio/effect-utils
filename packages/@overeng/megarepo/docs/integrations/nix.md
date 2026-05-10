# Megarepo + Nix/Devenv Integration

## Overview

Megarepo creates symlinks from `repos/<member>` to the megarepo store (`~/.megarepo/...`). This works well for most tooling, but Nix flakes have specific limitations around symlinks.

## Known Limitation: Nix Flakes Don't Follow Symlinks

Nix flakes explicitly **do not follow symlinks** in path inputs for security and reproducibility reasons. This means `path:` URLs that traverse megarepo symlinks will fail.

### The Problem

```yaml
# devenv.yaml - THIS WILL FAIL
inputs:
  playwright:
    url: path:repos/effect-utils/nix/playwright-flake # Goes through symlink!
```

Error:

```
error: path '.../repos/effect-utils' is a symlink
```

Or in CI:

```
error: '«unknown»/.megarepo/github.com/.../nix/playwright-flake' does not exist
```

### The Solution

Use GitHub URLs instead of local paths when referencing flakes from megarepo members:

```yaml
# devenv.yaml - CORRECT
inputs:
  playwright:
    url: github:overengineeringstudio/effect-utils?dir=nix/playwright-flake
```

### When Local Paths Are OK

Local `path:` URLs work fine when they **don't traverse symlinks**:

```yaml
# Inside effect-utils repo itself - OK (no symlink)
inputs:
  playwright:
    url: path:nix/playwright-flake
```

## Pattern to Avoid

```
path:repos/<member>/...
     ^^^^^^^^^^^^^^
     This is a megarepo symlink - Nix will reject it
```

## CI Considerations

In CI environments, the symlink target path may also contain unresolvable elements (like `«unknown»` for home directory), causing additional failures even if Nix did follow symlinks.

Using GitHub URLs ensures:

1. No symlink traversal issues
2. Portable across local dev and CI
3. Explicit versioning via git refs

## Local Development

Use GitHub URLs in `devenv.yaml` for standalone and CI compatibility. For local cross-repo iteration, compose the repos with megarepo and let lock sync move the consumer lock files to the sibling member commits.

### 1. devenv.yaml (committed, CI-compatible)

```yaml
inputs:
  playwright:
    url: github:overengineeringstudio/effect-utils?dir=nix/playwright-flake
```

### 2. Megarepo lock sync

```bash
mr apply --all
# edit repos/effect-utils
mr lock --all
```

This pattern gives you:

- **CI**: Uses GitHub URL (works without symlinks)
- **Local dev**: Uses the composed sibling commit recorded in `megarepo.lock`

### Notes

- Do not use per-shell `--override-input` for normal megarepo iteration.
- `devenv shell` should evaluate from checked-in lock files, so shell entry does not secretly change dependency identity.

## Trade-offs

| Approach               | Pros                                  | Cons                              |
| ---------------------- | ------------------------------------- | --------------------------------- |
| GitHub URL             | Works everywhere, explicit versioning | Can't test local changes directly |
| GitHub URL + lock sync | Local iteration with CI parity        | Requires composing the megarepo   |
| Local path             | Live updates during dev               | Fails through megarepo symlinks   |

For flakes you're actively developing, use megarepo lock sync or keep them in the same repo.

## Nix Lock Sync

When multiple megarepo members depend on each other via Nix flake inputs, you can end up with version drift between `megarepo.lock` and the individual `flake.lock`/`devenv.lock` files.

Megarepo solves this with **Nix Lock Sync**: during `mr lock`, `mr fetch --apply`, and `mr apply`, it updates `flake.lock` and `devenv.lock` files in member repos to match the commits in `megarepo.lock`.

### How It Works

1. After `megarepo.lock` is written or applied, megarepo scans each member for lock files
2. For each input in `flake.lock`/`devenv.lock`, it checks if the URL matches another megarepo member
3. If matched and the `rev` differs, it updates to match `megarepo.lock`
4. `narHash` and `lastModified` are removed (Nix recalculates these)

### Configuration

Lock sync is **auto-detected** by default: it is enabled if `devenv.lock` or `flake.lock` exists in the megarepo root directory. No configuration needed for the common case.

To disable:

```json
{
  "lockSync": { "enabled": false }
}
```

To exclude specific members:

```json
{
  "lockSync": { "exclude": ["member-name"] }
}
```

### Benefits

- **Single source of truth**: `megarepo.lock` controls all dependency versions
- **CI reproducibility**: No more version drift between lock files
- **Automatic**: No manual `nix flake update` needed for megarepo members
