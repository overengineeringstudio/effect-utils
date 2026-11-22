#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sys/file.h>

/* Bun FFI calls only these fixed-arity functions. The native C compiler handles
 * libc's variadic open/fcntl ABI, including stack arguments on Darwin arm64. */
int buck2_publication_owner_open(const char *path) {
  int fd = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
  return fd < 0 ? -errno : fd;
}

int buck2_publication_owner_lock(int fd, int mode) {
  return flock(fd, mode) == 0 ? 0 : errno;
}

int buck2_publication_owner_fd_flags(int fd) {
  return fcntl(fd, F_GETFD);
}
