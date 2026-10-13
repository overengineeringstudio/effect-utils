{ pkgs, invocation }:

# A fresh invocation keeps this observational, non-FOD build out of the cache.
# Its output is intentionally nondeterministic: mount IDs and build paths are
# evidence, so rebuilding an existing output would compare unrelated snapshots.
pkgs.stdenv.mkDerivation {
  name = "buck2-outer-sandbox-probe";
  inherit invocation;
  nativeBuildInputs = [
    pkgs.python3
    pkgs.coreutils
  ];
  dontUnpack = true;
  dontConfigure = true;
  dontInstall = true;
  dontFixup = true;

  buildPhase = ''
    runHook preBuild
    printf 'BUCK2_OUTER_SANDBOX_PROBE_ROOT_BEGIN\n'
    ls -la /
    printf 'BUCK2_OUTER_SANDBOX_PROBE_ROOT_END\n'
    printf 'BUCK2_OUTER_SANDBOX_PROBE_MOUNTINFO_BEGIN\n'
    cat /proc/self/mountinfo
    printf 'BUCK2_OUTER_SANDBOX_PROBE_MOUNTINFO_END\n'
    mkdir -p "$out"
    python3 - "$out/evidence.json" <<'PY'
    import errno
    import json
    import os
    import stat
    import sys

    file_types = {
        stat.S_IFDIR: "directory",
        stat.S_IFREG: "regular",
        stat.S_IFLNK: "symlink",
        stat.S_IFBLK: "block",
        stat.S_IFCHR: "character",
        stat.S_IFIFO: "fifo",
        stat.S_IFSOCK: "socket",
    }

    def inspect(path, operation):
        try:
            result = operation(path)
        except OSError as error:
            return {
                "errno": error.errno,
                "errno_name": errno.errorcode.get(error.errno),
            }
        return {
            "errno": 0,
            "dev": result.st_dev,
            "ino": result.st_ino,
            "realpath": os.path.realpath(path),
            "type": file_types.get(stat.S_IFMT(result.st_mode), "unknown"),
            "mode": stat.S_IMODE(result.st_mode),
        }

    with open("/etc/passwd") as stream:
        passwd = []
        for line in stream:
            name, _, uid, _, _, home, _ = line.rstrip("\n").split(":")
            passwd.append({"name": name, "uid": int(uid), "home": home})

    environment = {
        key: os.environ.get(key) for key in ("NIX_BUILD_TOP", "TMPDIR", "HOME")
    }
    top = os.environ["NIX_BUILD_TOP"]
    paths = ["/home", "/root", "/run/user", "/nix/var/nix", "/tmp", top,
             os.path.join(top, "tmp")]
    paths.extend(entry["home"] for entry in passwd)
    paths.extend(value for value in environment.values() if value is not None)
    with open("/proc/net/dev") as stream:
        net_dev = stream.read()
    with open("/proc/self/mountinfo") as stream:
        mountinfo = stream.read()
    evidence = {
        "schema": "buck2-outer-sandbox-probe/v1",
        "invocation": os.environ["invocation"],
        "environment": environment,
        "cwd": os.getcwd(),
        "uid": os.getuid(),
        "passwd": passwd,
        "paths": {
            path: {"stat": inspect(path, os.stat), "lstat": inspect(path, os.lstat)}
            for path in dict.fromkeys(paths)
        },
        "proc_net_dev": net_dev,
        "mountinfo": mountinfo,
    }
    with open(sys.argv[1], "w") as stream:
        json.dump(evidence, stream, indent=2, sort_keys=True)
        stream.write("\n")
    PY
    printf 'BUCK2_OUTER_SANDBOX_PROBE_EVIDENCE_BEGIN\n'
    cat "$out/evidence.json"
    printf 'BUCK2_OUTER_SANDBOX_PROBE_EVIDENCE_END\n'
    runHook postBuild
  '';
}
