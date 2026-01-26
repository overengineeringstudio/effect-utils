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
    url: path:repos/effect-utils/nix/playwright-flake  # Goes through symlink!
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

## Trade-offs

| Approach | Pros | Cons |
|----------|------|------|
| GitHub URL | Works everywhere, explicit versioning | Can't test local changes directly |
| Local path | Live updates during dev | Fails through megarepo symlinks |

For flakes you're actively developing, consider keeping them in the same repo or using `nix develop` with explicit paths that don't go through megarepo symlinks.
