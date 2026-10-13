// M0 TCC attribution probe. Modes:
//   probe access <tag>                 open an FDA-protected dir, print errno
//   probe spawn <tag> <child>          posix_spawn <child> access <tag>
//   probe spawn-disclaim <tag> <child> same, child disclaims responsibility
//   probe serve <sock>                 accept connections; each line "<tag>" -> access(tag)
//   probe ask <sock> <tag>             connect to serve socket and request access
#include <dirent.h>
#include <errno.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

static int do_access(const char *tag, char *out, size_t n) {
  char path[1024];
  snprintf(path, sizeof path, "%s/Library/Safari", getenv("HOME") ? getenv("HOME") : "/var/empty");
  DIR *d = opendir(path);
  int e = d ? 0 : errno;
  if (d) closedir(d);
  snprintf(out, n, "tag=%s pid=%d ppid=%d result=%s errno=%d\n", tag, getpid(), getppid(),
           d ? "OK" : "DENIED", e);
  return e;
}

static int do_spawn(const char *tag, const char *child, int disclaim) {
  posix_spawnattr_t a;
  posix_spawnattr_init(&a);
  if (disclaim) responsibility_spawnattrs_setdisclaim(&a, 1);
  char *argv[] = {(char *)child, "access", (char *)tag, NULL};
  pid_t pid;
  int rc = posix_spawn(&pid, child, NULL, &a, argv, environ);
  if (rc) { fprintf(stderr, "spawn failed %d\n", rc); return 2; }
  int st;
  waitpid(pid, &st, 0);
  return WEXITSTATUS(st);
}

int main(int argc, char **argv) {
  char buf[512];
  if (argc >= 3 && !strcmp(argv[1], "access")) {
    do_access(argv[2], buf, sizeof buf);
    fputs(buf, stdout);
    return 0;
  }
  if (argc >= 4 && !strcmp(argv[1], "spawn")) return do_spawn(argv[2], argv[3], 0);
  if (argc >= 4 && !strcmp(argv[1], "spawn-disclaim")) return do_spawn(argv[2], argv[3], 1);
  if (argc >= 3 && (!strcmp(argv[1], "serve") || !strcmp(argv[1], "ask"))) {
    struct sockaddr_un sa = {.sun_family = AF_UNIX};
    strncpy(sa.sun_path, argv[2], sizeof sa.sun_path - 1);
    int s = socket(AF_UNIX, SOCK_STREAM, 0);
    if (!strcmp(argv[1], "ask")) {
      if (argc < 4 || connect(s, (void *)&sa, sizeof sa)) { perror("connect"); return 2; }
      dprintf(s, "%s\n", argv[3]);
      ssize_t r = read(s, buf, sizeof buf - 1);
      if (r > 0) { buf[r] = 0; fputs(buf, stdout); }
      return 0;
    }
    unlink(argv[2]);
    if (bind(s, (void *)&sa, sizeof sa) || listen(s, 4)) { perror("bind"); return 2; }
    for (;;) {
      int c = accept(s, NULL, NULL);
      if (c < 0) continue;
      char tag[128] = {0};
      ssize_t r = read(c, tag, sizeof tag - 1);
      if (r > 0) tag[strcspn(tag, "\n")] = 0;
      do_access(tag, buf, sizeof buf);
      write(c, buf, strlen(buf));
      close(c);
    }
  }
  fprintf(stderr, "usage\n");
  return 64;
}
