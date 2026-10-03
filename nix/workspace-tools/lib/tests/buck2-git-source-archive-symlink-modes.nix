{ pkgs }:
let
  source = pkgs.runCommand "buck2-git-archive-symlink-source" { } ''
    mkdir -p "$out/src"
    printf 'source bytes\n' > "$out/src/lib.rs"
    printf '#!/bin/sh\nprintf executable\\n\n' > "$out/src/tool"
    chmod +x "$out/src/tool"
    ln -s lib.rs "$out/src/current.rs"
  '';
  # Linux cannot chmod symlinks. Interpose only the filesystem metadata that
  # differs on Darwin; GNU tar, the builder, file bytes and link targets are real.
  symlinkMode = pkgs.runCommand "buck2-git-archive-symlink-mode" {
    nativeBuildInputs = [ pkgs.stdenv.cc ];
  } ''
    mkdir -p "$out"
    cat > mode.c <<'EOF'
    #define _GNU_SOURCE
    #include <dlfcn.h>
    #include <stdlib.h>
    #include <sys/stat.h>

    int fstatat(int fd, const char *path, struct stat *st, int flags) {
      static int (*real_fstatat)(int, const char *, struct stat *, int);
      static mode_t mode;
      if (real_fstatat == NULL) {
        real_fstatat = dlsym(RTLD_NEXT, "fstatat");
        mode = strtoul(getenv("BUCK2_TEST_SYMLINK_MODE"), NULL, 8);
      }
      int result = real_fstatat(fd, path, st, flags);
      if (result == 0 && S_ISLNK(st->st_mode))
        st->st_mode = S_IFLNK | mode;
      return result;
    }
    EOF
    cc -shared -fPIC -o "$out/mode.so" mode.c -ldl
  '';
  archive = import ../buck2-git-source-archive.nix {
    inherit pkgs;
    src = source;
    repo = "https://github.com/owner/demo";
    rev = "0123456789abcdef0123456789abcdef01234567";
    stripPrefix = "demo-0123456789abcdef0123456789abcdef01234567";
  };
  withMode = mode: archive.overrideAttrs {
    LD_PRELOAD = "${symlinkMode}/mode.so";
    BUCK2_TEST_SYMLINK_MODE = mode;
  };
  linuxArchive = withMode "0777";
  darwinArchive = withMode "0755";
in
assert pkgs.stdenv.hostPlatform.isLinux;
pkgs.runCommand "buck2-git-archive-symlink-modes-test" {
  nativeBuildInputs = [ pkgs.coreutils pkgs.gnutar pkgs.gzip ];
} ''
  # Prove the fixture changes the actual tar headers before comparing normalized
  # output; a non-intercepted stat call must not make this test vacuously pass.
  for mode in 0777 0755; do
    LD_PRELOAD=${symlinkMode}/mode.so BUCK2_TEST_SYMLINK_MODE="$mode" \
      tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner \
      --format=posix --pax-option=delete=atime,delete=ctime \
      -C ${source} -cf "raw-$mode.tar" .
  done
  if cmp -s raw-0777.tar raw-0755.tar; then
    echo 'symlink-mode fixture did not produce distinct tar headers' >&2
    exit 1
  fi
  cmp ${linuxArchive}/archive.tgz ${darwinArchive}/archive.tgz
  mkdir extracted
  tar -xzf ${linuxArchive}/archive.tgz -C extracted
  root=extracted/demo-0123456789abcdef0123456789abcdef01234567
  test "$(readlink "$root/src/current.rs")" = lib.rs
  test "$(cat "$root/src/current.rs")" = 'source bytes'
  test "$(stat -c '%a' "$root/src/lib.rs")" = 444
  test "$(stat -c '%a' "$root/src/tool")" = 555
  tar -tvzf ${linuxArchive}/archive.tgz | grep '^lr-xr-xr-x .*src/current.rs -> lib.rs$'
  mkdir -p "$out"
  cp ${linuxArchive}/archive.tgz "$out/"
''
