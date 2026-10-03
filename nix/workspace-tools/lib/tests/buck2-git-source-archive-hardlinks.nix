{ pkgs }:
let
  archive = import ../buck2-git-source-archive.nix {
    inherit pkgs;
    src = "./hardlink-source";
    repo = "https://github.com/owner/demo";
    rev = "0123456789abcdef0123456789abcdef01234567";
    stripPrefix = "demo-0123456789abcdef0123456789abcdef01234567";
    expectedSha256 = "82c56d4acf86570d397f2827f45a72dbd0a792eeb7b363f1643cf5d4f6d91d02";
  };
in
archive.overrideAttrs (previous: {
  name = "buck2-git-archive-hardlinks-test";
  nativeBuildInputs = previous.nativeBuildInputs ++ [ pkgs.gnugrep ];
  buildCommand =
    ''
      # NAR substitution does not preserve inode identity. Construct the physical
      # hardlinks in this builder, not in a separately materialized store input.
      mkdir -p hardlink-source/src
      printf 'identical source bytes\n' > hardlink-source/src/first.rs
      ln hardlink-source/src/first.rs hardlink-source/src/second.rs
      chmod -R a-w hardlink-source
      test "$(stat -c '%d:%i' hardlink-source/src/first.rs)" = "$(stat -c '%d:%i' hardlink-source/src/second.rs)"
      test "$(stat -c '%h' hardlink-source/src/first.rs)" = 2
    ''
    + previous.buildCommand
    + ''
      entries="$(tar -tvzf "$out/archive.tgz")"
      test "$(printf '%s\n' "$entries" | grep -c '^-')" = 2
      if printf '%s\n' "$entries" | grep '^h'; then
        echo 'buck2-git-source-archive: physical source hardlinks leaked into the archive' >&2
        exit 1
      fi
      echo "buck2-git-source-archive-hardlinks: PASS physical link count 2, two regular entries, pinned digest $(tail -n 1 "$out/source.sha256")"
    '';
})
