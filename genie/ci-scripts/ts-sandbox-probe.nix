# Temporary #1212 runner probe. Nonce forces execution in the current CI job.
{
  pkgs,
  bubblewrap,
  nonce,
}:
let
  closure = pkgs.closureInfo { rootPaths = [ pkgs.bun ]; };
in
pkgs.runCommand "ts-sandbox-nested-probe-${nonce}" { } ''
  set -euo pipefail
  echo 'TS sandbox probe: outer Nix /proc/net/dev' >&2
  ${pkgs.coreutils}/bin/cat /proc/net/dev >&2
  mkdir -p "$out" "$PWD/scratch"
  printf 'declared input\n' > "$PWD/input.txt"
  binds=()
  while IFS= read -r path; do
    binds+=(--ro-bind "$path" "$path")
  done < ${closure}/store-paths
  ${bubblewrap}/bin/bwrap \
    --unshare-all --unshare-user --die-with-parent --new-session \
    --disable-userns --clearenv \
    --proc /proc --remount-ro /proc \
    --dev /dev --remount-ro /dev \
    --tmpfs /tmp \
    --bind "$PWD/scratch" "$PWD/scratch" \
    --dir "$PWD" \
    --bind "$out" "$out" \
    --ro-bind "$PWD/input.txt" "$PWD/input.txt" \
    "''${binds[@]}" \
    --remount-ro / --chdir "$PWD" \
    --setenv LC_ALL C --setenv TZ UTC \
    --setenv TMPDIR /tmp --setenv BUCK_SCRATCH_PATH "$PWD/scratch" \
    --setenv PWD "$PWD" \
    -- ${pkgs.bun}/bin/bun --no-env-file --no-install -e '
      const fs = require("node:fs");
      if (fs.readFileSync("input.txt", "utf8") !== "declared input\n") throw Error("input view");
      const networkView = fs.readFileSync("/proc/net/dev", "utf8");
      console.error("TS sandbox probe: /proc/net/dev=" + JSON.stringify(networkView));
      const interfaces = networkView.split("\n").filter(line => line.includes(":"));
      if (interfaces.length !== 1 || interfaces[0].split(":")[0].trim() !== "lo") throw Error("network boundary: " + JSON.stringify(interfaces));
      if (Object.keys(process.env).sort().join(",") !== "BUCK_SCRATCH_PATH,LC_ALL,PWD,TMPDIR,TZ") throw Error("environment boundary");
      for (const path of ["/home", "/root", "/nix/var/nix"]) {
        try { fs.lstatSync(path); throw Error("visible host path: " + path); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      let readOnly = false;
      try { fs.writeFileSync("input.txt", "changed"); }
      catch (error) { if (error.code !== "EROFS") throw error; readOnly = true; }
      if (!readOnly) throw Error("writable input");
      fs.writeFileSync(process.env.BUCK_SCRATCH_PATH + "/proof", "scratch writable\n");
      fs.writeFileSync("/tmp/proof", "tmp writable\n");
      fs.writeFileSync(process.argv[1] + "/proof", "default nested Bubblewrap passed\n");
    ' "$out"
  test -s "$out/proof"
  echo 'TS sandbox probe: strict Nix build and default nested Bubblewrap passed' >&2
''
