# Megarepo Roadmap

This document tracks potential future features for consideration. These are **not** planned features - they are ideas to evaluate if user demand emerges.

## Potential Future Considerations

### Shallow Clones

**What**: Support `--depth` option for large repositories.

**Use case**: Working with very large repos where full history isn't needed.

**Considerations**:

- Bare repos with shallow clones have limitations
- Some git operations may fail
- Would need "unshallowing" capability

**Status**: Evaluate if users report issues with large repos.

---

### Submodules Support

**What**: Proper handling of repos containing git submodules.

**Use case**: Projects using submodules for vendored dependencies.

**Considerations**:

- Bare repos don't automatically include submodule content
- Need to decide: recursive clone or skip?
- Adds complexity to sync and GC

**Status**: Out of scope initially.

---

### Git LFS Support

**What**: Proper handling of repos using Git Large File Storage.

**Use case**: Repos with large binary files.

**Considerations**:

- LFS works differently with bare repos
- May need `git lfs fetch` after worktree creation
- Authentication for LFS servers

**Status**: Evaluate if users work with LFS repos.

---

### Store Status Command

**What**: `mr store status` command showing detailed store state.

**Use case**: Debugging, understanding disk usage, finding dirty worktrees.

**Status**: Add if `mr store gc` proves insufficient.

---

### Explicit Tag/Branch Syntax

**What**: `#tag:v1.0.0` or `#branch:main` to override heuristics.

**Use case**: When the semver heuristic guesses wrong.

**Status**: Add only if heuristic proves problematic.

---

### Multi-Megarepo GC

**What**: `mr store gc` that scans multiple megarepos.

**Current**: GC only considers current megarepo's lock file.

**Future**: Registry of known megarepos for comprehensive GC.

**Status**: Current single-megarepo approach should suffice initially.
