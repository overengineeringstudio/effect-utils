#define _POSIX_C_SOURCE 200809L
#include <sys/prctl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Linux-only integration fixture. The caller uses exec argv[0] (Node's argv0)
 * for the real /proc cmdline identity; no procfs or permission failure is faked.
 * Environment configuration leaves argv exactly equal to the production title.
 * Readiness follows both prctl calls, so the parent never races dumpability. */
int main(void) {
  const char *comm = getenv("EDITOR_VIEW_READER_TEST_COMM");
  if (!comm || !*comm || strlen(comm) > 15) return 2;
  if (prctl(PR_SET_NAME, (unsigned long)comm, 0UL, 0UL, 0UL) < 0) {
    perror("PR_SET_NAME");
    return 3;
  }
  if (prctl(PR_SET_DUMPABLE, 0UL, 0UL, 0UL, 0UL) < 0) {
    perror("PR_SET_DUMPABLE");
    return 4;
  }
  if (puts("ready") == EOF || fflush(stdout) == EOF) return 5;
  /* stdin is a parent-owned pipe: EOF also cleans up if the test runner dies. */
  char byte;
  while (read(STDIN_FILENO, &byte, 1) > 0) {}
  return 0;
}
