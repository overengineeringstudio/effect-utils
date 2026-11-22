{ pkgs }:
let
  libraryName = "libbuck2-publication-owner${pkgs.stdenv.hostPlatform.extensions.sharedLibrary}";
  # Scoped publication runtimes capture this closure; discard unrelated flake source identity.
  source = builtins.path {
    path = ../scripts/buck2-publication-owner.c;
    name = "buck2-publication-owner.c";
  };
in
pkgs.runCommand "buck2-publication-owner-native"
  {
    nativeBuildInputs = [ pkgs.stdenv.cc ];
    passthru = { inherit libraryName; };
  }
  ''
    mkdir -p "$out/lib"
    ${pkgs.stdenv.cc}/bin/cc ${
      if pkgs.stdenv.hostPlatform.isDarwin then "-dynamiclib" else "-shared -fPIC"
    } -O2 ${source} -o "$out/lib/${libraryName}"
    cat > owner-check.c <<'EOF'
    #include <errno.h>
    #include <fcntl.h>
    #include <sys/file.h>
    #include <unistd.h>
    int buck2_publication_owner_open(const char *);
    int buck2_publication_owner_lock(int, int);
    int main(void) {
      const char *path = "owner-native-check.lock";
      int fd = buck2_publication_owner_open(path);
      if (fd < 0 || fcntl(fd, F_GETFD) != FD_CLOEXEC) return 1;
      if (fcntl(fd, F_SETFD, 0) != 0 ||
          fcntl(fd, F_GETFD) != 0) return 2;
      if (fcntl(fd, F_SETFD, FD_CLOEXEC) != 0 ||
          fcntl(fd, F_GETFD) != FD_CLOEXEC) return 3;
      if (buck2_publication_owner_lock(fd, LOCK_EX | LOCK_NB) != 0) return 4;
      int rival = buck2_publication_owner_open(path);
      if (rival < 0) return 5;
      int conflict = buck2_publication_owner_lock(rival, LOCK_EX | LOCK_NB);
      if (conflict != EWOULDBLOCK && conflict != EAGAIN) return 6;
      close(rival);
      close(fd);
      unlink(path);
      return 0;
    }
    EOF
    ${pkgs.stdenv.cc}/bin/cc -Wall -Wextra -Werror owner-check.c \
      -L"$out/lib" -lbuck2-publication-owner -Wl,-rpath,"$out/lib" -o owner-check
    ./owner-check
  ''
