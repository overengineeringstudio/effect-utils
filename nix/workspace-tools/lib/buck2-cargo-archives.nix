# Offline crate supply for sandboxed Buck builds (`mkBuckProductFromSource`).
#
# Registry archives and ordinary Git archives retain their reviewed byte digests.
# A declared Git source instead supplies a deterministic tarball, accompanied by
# its source digest so Buck can verify those different bytes before extraction.
{
  pkgs,
  # Reindeer graph files (`third-party/BUCK`) as paths.
  thirdPartyBuckFiles,
  # GitHub owner/repo -> pinned flake input (or a local path fixture).
  gitSources ? { },
}:

let
  lib = pkgs.lib;
  parseGraph =
    file:
    let
      blocks = lib.drop 1 (lib.splitString "\ncrate_archive(\n" ("\n" + builtins.readFile file));
      parseBlock =
        block:
        let
          body = builtins.head (lib.splitString "\n)\n" block);
          field =
            name: pattern:
            let
              matches = builtins.filter (m: m != null) (
                map (line: builtins.match pattern line) (lib.splitString "\n" body)
              );
            in
            if builtins.length matches == 1 then
              builtins.head (builtins.head matches)
            else
              throw "buck2-cargo-archives: ${toString file} crate_archive needs exactly one ${name}";
        in
        {
          sha256 = field "sha256" ''[[:space:]]*sha256 = "([0-9a-f]{64})",[[:space:]]*'';
          url = field "url" ''[[:space:]]*urls = \["(https://[^"]+)"],[[:space:]]*'';
        };
      archives = map parseBlock blocks;
    in
    assert lib.assertMsg
      (archives != [ ] || lib.hasInfix "\ngit_archive(\n" ("\n" + builtins.readFile file))
      "buck2-cargo-archives: ${toString file} declares no crate_archive (Reindeer [buck] http_archive = \"crate_archive\")";
    archives;
  parseGitArchives =
    file:
    let
      sidecar = dirOf file + "/git-archives.json";
      pins = builtins.fromJSON (builtins.readFile sidecar);
      graphText = builtins.readFile file;
    in
    if !(builtins.pathExists sidecar) then
      [ ]
    else
      assert lib.assertMsg (
        pins.schema or null == "effect-utils/buck2-git-archives/v1"
      ) "buck2-cargo-archives: ${toString sidecar} must carry schema effect-utils/buck2-git-archives/v1";
      assert lib.assertMsg (lib.hasInfix "\ngit_archive(\n" ("\n" + graphText))
        "buck2-cargo-archives: ${toString sidecar} pins git sources but ${toString file} declares no git_archive";
      map (
        pin:
        assert lib.assertMsg (
          builtins.match "[0-9a-f]{64}" pin.sha256 != null
        ) "buck2-cargo-archives: ${toString sidecar} ${pin.repo} needs a lowercase hex sha256";
        assert lib.assertMsg (
          builtins.match "https://github.com/[^\"]+[.]tar[.]gz" pin.url != null
        ) "buck2-cargo-archives: ${toString sidecar} ${pin.repo} needs a GitHub archive url";
        {
          inherit (pin) sha256 url;
          source =
            let
              repo = lib.removeSuffix ".git" (
                lib.removeSuffix "/" (lib.removePrefix "https://github.com/" pin.repo)
              );
              input = gitSources.${repo} or null;
              rev = if builtins.isAttrs input then input.rev or null else null;
              src =
                if builtins.isAttrs input then
                  input.outPath
                else
                  builtins.path {
                    path = input;
                    name = "buck2-git-source-${lib.replaceStrings [ "/" ] [ "-" ] repo}";
                  };
            in
            assert lib.assertMsg (
              builtins.match "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+" repo != null
            ) "buck2-cargo-archives: ${toString sidecar} has invalid GitHub repo ${pin.repo}";
            if input == null then
              null
            else
              assert lib.assertMsg (
                builtins.match "[0-9a-f]{40}" pin.rev != null
                && builtins.match "[A-Za-z0-9_.-]+" pin.strip_prefix != null
              ) "buck2-cargo-archives: ${toString sidecar} ${repo} needs a 40-hex rev and safe strip_prefix";
              assert lib.assertMsg (
                builtins.isPath input
                || (builtins.isString input && lib.hasPrefix "/" input)
                || (builtins.isAttrs input && input ? outPath && rev != null)
              ) "buck2-cargo-archives: gitSources.${repo} must be a path or a pinned flake input with rev";
              assert lib.assertMsg (
                rev == null || rev == pin.rev
              ) "buck2-cargo-archives: gitSources.${repo} rev ${toString rev} does not match Cargo.lock rev ${pin.rev}";
              pkgs.runCommand "buck2-git-source-${lib.replaceStrings [ "/" ] [ "-" ] repo}-${pin.rev}" {
                nativeBuildInputs = [ pkgs.gnutar pkgs.gzip pkgs.coreutils ];
              } ''
                set -euo pipefail
                mkdir -p "$out"
                tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
                  --format=posix --pax-option=delete=atime,delete=ctime \
                  --transform='flags=r;s|^\.|${pin.strip_prefix}|' \
                  -C ${lib.escapeShellArg (toString src)} \
                  -cf - . | gzip -n > "$out/archive.tgz"
                printf '%s\n%s\n' '${pin.repo}' '${pin.rev}' > "$out/source.sha256"
                sha256sum "$out/archive.tgz" | cut -d' ' -f1 >> "$out/source.sha256"
              '';
        }
      ) pins.archives;
  archives = lib.concatMap parseGraph thirdPartyBuckFiles ++ lib.concatMap parseGitArchives thirdPartyBuckFiles;
  archivesByDigest = builtins.listToAttrs (
    map (archive: {
      name = archive.sha256;
      value = archive;
    }) archives
  );
in
pkgs.linkFarm "buck2-cargo-archives" (
  lib.concatMap (
    archive:
    let
      sha256 = archive.sha256;
    in
    if archive.source or null == null then
      [ {
        name = "${sha256}.tgz";
        path = pkgs.fetchurl {
          inherit (archive) url sha256;
          name = "${sha256}.tgz";
        };
      } ]
    else
      [
        {
          name = "${sha256}.tgz";
          path = "${archive.source}/archive.tgz";
        }
        {
          name = "${sha256}.source.sha256";
          path = "${archive.source}/source.sha256";
        }
      ]
  ) (builtins.attrValues archivesByDigest)
)
