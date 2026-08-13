# Buck2 Repository Build Intuition

_For: repository maintainers and build-system authors - Assumes: Buck and Nix
fundamentals - Covers: the three authority boundaries_

Buck, Nix, and a consuming control plane solve different problems:

```text
repository intent -> Buck deterministic work -> BuildProduct
Nix inputs -----------------------------------> Nix import/store realization
control plane -------- trace + policy --------> live consumer effects
```

Buck owns admitted repository-local computation. Nix owns immutable inputs and
the independent store boundary. The control plane owns observation and anything
that changes a live system. The contracts pass data in one direction; none of
the systems becomes a hidden second producer for another.

The reusable part is deliberately smaller than a repository. The public kernel
defines schemas and mechanics. Repository adapters keep labels, paths,
dependency choices, aliases, and private policy local. This is what allows the
same build mechanism to compound without centralizing repository authority.

OpenTelemetry is part of the operating contract, not part of Buck's result. The
control plane records the invocation and derives telemetry from native evidence,
optionally through a justified observer. If telemetry export fails, the Buck
result remains true; if required evidence is missing, admission has no verdict.
