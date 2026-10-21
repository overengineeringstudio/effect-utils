#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char executable[PATH_MAX];
  uint32_t size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &size) != 0) {
    fputs("Chromium launcher: executable path too long\n", stderr);
    return 1;
  }
  char original[PATH_MAX];
  if (realpath(executable, original) == NULL) {
    perror("Chromium launcher: realpath");
    return 1;
  }
  char *name = strrchr(original, '/');
  const char suffix[] = "/Google Chrome for Testing.original";
  if (name == NULL || (size_t)(name - original) + sizeof(suffix) > sizeof(original)) {
    fputs("Chromium launcher: invalid executable path\n", stderr);
    return 1;
  }
  memcpy(name, suffix, sizeof(suffix));
  char *arguments[argc + 2];
  arguments[0] = original;
  arguments[1] = "--use-mock-keychain";
  for (int i = 1; i < argc; ++i) arguments[i + 1] = argv[i];
  arguments[argc + 1] = NULL;
  execv(original, arguments);
  perror("Chromium launcher: execv");
  return 1;
}
