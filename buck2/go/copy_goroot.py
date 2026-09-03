"""Materializes a Nix-realized GOROOT as a Buck output directory.

`prelude//go:go_stdlib.bzl` takes `goroot` as `dynattrs.value(Artifact)` and
projects individual stdlib source files out of it, so the prelude-native Go graph
cannot consume an immutable `/nix/store` GOROOT directly: it needs a real
directory inside `buck-out`. Prelude's own `go/tools/copy_goroot.go` does the same
copy but discovers the directory by shelling out to a bare `go` on `PATH`; here
the exact store path is a declared argument, so nothing is read from the ambient
environment.
"""

import os
import shutil
import sys

if len(sys.argv) != 3:
    print("usage: copy_goroot.py <goroot> <output>", file=sys.stderr)
    raise SystemExit(1)

goroot, output = sys.argv[1], sys.argv[2]
if not goroot.startswith("/nix/store/"):
    print(f"GOROOT must be an immutable Nix store path: {goroot}", file=sys.stderr)
    raise SystemExit(1)

shutil.copytree(goroot, output, symlinks=True, dirs_exist_ok=True)
# The store is read-only; the stdlib build writes nothing into GOROOT, but Buck
# must be able to clean the output tree.
for root, dirs, files in os.walk(output):
    for name in dirs + files:
        path = os.path.join(root, name)
        if not os.path.islink(path):
            os.chmod(path, os.stat(path).st_mode | 0o200)
