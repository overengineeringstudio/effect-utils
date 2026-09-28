# Offline crate supply for sandboxed Buck builds (`mkBuckProductFromSource`).
#
# Reads the committed, freshness-gated Reindeer graphs (`crate_archive` entries
# pinned by the Cargo.lock sha256) at evaluation — they are source files, not
# build outputs — and realizes one fixed-output fetch per digest. The Buck rule
# `@rules//buck2/rust:crates.bzl` copies `<sha256>.tgz` from this tree when
# `nix_store.crates_root` is set. Git sources come from the graph's sibling
# `git-archives.json` sidecar (GitHub commit tarballs pinned by sha256, gated by
# `scripts/buck2-rust-deps.sh`) and share the `<sha256>.tgz` layout.
# Acquisition only: nothing is published.
{
  pkgs,
  # Reindeer graph files (`third-party/BUCK`) as paths.
  thirdPartyBuckFiles,
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
        }
      ) pins.archives;
  archives =
    lib.concatMap parseGraph thirdPartyBuckFiles ++ lib.concatMap parseGitArchives thirdPartyBuckFiles;
  archivesByDigest = builtins.listToAttrs (
    map (archive: {
      name = archive.sha256;
      value = pkgs.fetchurl {
        inherit (archive) url sha256;
        name = "${archive.sha256}.tgz";
      };
    }) archives
  );
in
pkgs.linkFarm "buck2-cargo-archives" (
  lib.mapAttrsToList (sha256: path: {
    name = "${sha256}.tgz";
    inherit path;
  }) archivesByDigest
)
