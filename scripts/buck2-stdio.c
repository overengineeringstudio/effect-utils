/* fcntl is variadic: Darwin arm64 passes its third argument on the stack.
 * Export fixed-arity wrappers so Bun FFI does not have to model that ABI.
 * F_GETFL=3 and F_SETFL=4 are identical on supported Linux and macOS hosts.
 * Declare the POSIX ABI directly: bootstrap must not require SDK headers. */
extern int fcntl(int descriptor, int command, ...);

int eu_getfl(int descriptor) {
  return fcntl(descriptor, 3);
}

int eu_setfl(int descriptor, int flags) {
  return fcntl(descriptor, 4, flags);
}
