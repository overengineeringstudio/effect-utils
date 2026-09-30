{ pkgs }:
let
  source = pkgs.runCommand "buck2-git-archive-hardlink-source" { } ''
    mkdir -p "$out/src"
    printf 'identical source bytes\n' > "$out/src/first.rs"
    ln "$out/src/first.rs" "$out/src/second.rs"
  '';
  archive = import ../buck2-git-source-archive.nix {
    inherit pkgs;
    src = source;
    repo = "https://github.com/owner/demo";
    rev = "0123456789abcdef0123456789abcdef01234567";
    stripPrefix = "demo-0123456789abcdef0123456789abcdef01234567";
  };
in
pkgs.runCommand "buck2-git-archive-hardlinks-test" { nativeBuildInputs = [ pkgs.coreutils pkgs.gnutar ]; } ''
  test "$(stat -c '%d:%i' ${source}/src/first.rs)" = "$(stat -c '%d:%i' ${source}/src/second.rs)"
  if tar -tvzf ${archive}/archive.tgz | grep '^h'; then
    echo 'buck2-git-source-archive: physical source hardlinks leaked into the archive' >&2
    exit 1
  fi
  mkdir -p "$out"
  cp ${archive}/archive.tgz "$out/"
''
