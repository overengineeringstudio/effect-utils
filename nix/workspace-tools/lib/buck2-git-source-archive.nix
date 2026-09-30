# The Reindeer pin gate and sandboxed product builder use identical source bytes.
{
  pkgs,
  repo,
  rev,
  stripPrefix,
  src,
  expectedSha256 ? null,
}:
pkgs.runCommand
  "buck2-git-source-${
    pkgs.lib.replaceStrings [ "/" ] [ "-" ] (pkgs.lib.removePrefix "https://github.com/" repo)
  }-${rev}"
  {
    nativeBuildInputs = [
      pkgs.gnutar
      pkgs.gzip
      pkgs.coreutils
    ];
  }
  ''
    set -euo pipefail
    mkdir -p "$out"
    tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
      --format=posix --pax-option=delete=atime,delete=ctime \
      --transform='flags=r;s|^\.|${stripPrefix}|' \
      -C ${pkgs.lib.escapeShellArg (toString src)} \
      -cf - . | gzip -n > "$out/archive.tgz"
    printf '%s\n%s\n' '${repo}' '${rev}' > "$out/source.sha256"
    digest="$(sha256sum "$out/archive.tgz" | cut -d' ' -f1)"
    ${pkgs.lib.optionalString (expectedSha256 != null) ''
      if [ "$digest" != ${pkgs.lib.escapeShellArg expectedSha256} ]; then
        echo "buck2-cargo-archives: ${repo}@${rev} source archive digest $digest does not match git-archives.json ${expectedSha256}" >&2
        exit 1
      fi
    ''}
    printf '%s\n' "$digest" >> "$out/source.sha256"
  ''
