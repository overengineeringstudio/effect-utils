#define _POSIX_C_SOURCE 200809L
#include <sys/prctl.h>
#include <sys/wait.h>
#include <errno.h>
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
  const char *mode = getenv("EDITOR_VIEW_READER_TEST_MODE");
  pid_t child = -1;
  int zombie = mode && !strcmp(mode, "zombie");
  int exit_race = mode && !strcmp(mode, "exit-race");
  if (zombie || exit_race) {
    int ready[2];
    if (pipe(ready) < 0) return 11;
    child = fork();
    if (child < 0) return 6;
    if (child == 0) {
      close(ready[0]);
      if (prctl(PR_SET_NAME, (unsigned long)"exited-reader", 0UL, 0UL, 0UL) < 0) _exit(10);
      if (write(ready[1], "r", 1) != 1) _exit(12);
      close(ready[1]);
      if (zombie) _exit(0);
      for (;;) pause();
    }
    close(ready[1]);
    char ready_byte;
    if (read(ready[0], &ready_byte, 1) != 1) return 13;
    close(ready[0]);
    if (zombie) {
      /* Observe termination WITHOUT reaping: the census sees a real zombie. */
      siginfo_t info;
      if (waitid(P_PID, (id_t)child, &info, WEXITED | WNOWAIT) < 0) return 7;
    }
    if (printf("ready %ld\n", (long)child) < 0 || fflush(stdout) == EOF) return 5;
    if (exit_race) {
      /* Reap promptly when the TS scheduling hook kills the scanned child. */
      while (waitpid(child, 0, 0) < 0) {
        if (errno != EINTR) return 8;
      }
    }
  } else if (puts("ready") == EOF || fflush(stdout) == EOF) return 5;
  /* stdin is a parent-owned pipe: EOF also cleans up if the test runner dies. */
  char byte;
  while (read(STDIN_FILENO, &byte, 1) > 0) {}
  if (zombie && waitpid(child, 0, 0) < 0) return 9;
  return 0;
}
