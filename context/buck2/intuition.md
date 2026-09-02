# Buck2 Repository Build Intuition

_For: repository maintainers and build-system authors - Assumes: Buck and Nix
fundamentals - Covers: the authority boundaries and the reuse model_

Buck, Nix, and the consuming control plane solve different problems:

```text
authored intent -> Buck deterministic work -> shared cache -> BuildProduct
Nix inputs ------------------------------------------------> Nix import/store
control plane ------------- trace + policy ----------------> live effects
```

Buck owns admitted repository-local computation, including dependency
materialization and the editor surface. Nix owns immutable inputs and the
independent store boundary. The control plane owns observation and anything
that changes a live system. Contracts pass data in one direction; none of the
systems becomes a hidden second producer for another.

Reuse is the point, and identity is what makes it work. Action keys follow
result-affecting inputs and nothing else, so one shared cache serves every
worktree, machine, and composed repository — provided the composition shape is
canonical. That is why every build runs from a synthesized composition root:
mount paths, cell names, platform labels, and the isolation dir all enter
action identity, and megarepo/genie hold them constant so identical work keys
identically everywhere.

The reusable part is deliberately smaller than a repository: shared rules and
schemas carry no private facts, so a second consumer (dotfiles first) can
extract them when it adopts. Telemetry is part of the operating contract, not
part of Buck's result: if export fails, the Buck result remains true.
