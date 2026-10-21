/* Offline example: fixed scheduled work or a resident local readiness protocol.
 * No network, GUI APIs, TCC calls, subprocesses, or responsibility disclaim. */
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3 || (strcmp(argv[1], "resident") != 0 &&
                    strcmp(argv[1], "scheduled") != 0)) {
    fputs("expected fixed scheduled SOCKET or resident SOCKET mode\n", stderr);
    return 64;
  }
  int scheduled = strcmp(argv[1], "scheduled") == 0;
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
#ifdef __APPLE__
  address.sun_len = sizeof(address);
#endif
  if (strlen(argv[2]) >= sizeof(address.sun_path)) return 64;
  memcpy(address.sun_path, argv[2], strlen(argv[2]) + 1);
  struct stat previous;
  if (lstat(argv[2], &previous) == 0) {
    if (!S_ISSOCK(previous.st_mode) || previous.st_uid != getuid()) return 73;
    if (unlink(argv[2]) != 0) return 73;
  } else if (errno != ENOENT) {
    return 73;
  }
  signal(SIGPIPE, SIG_IGN);
  int server = socket(AF_UNIX, SOCK_STREAM, 0);
  if (server < 0) return 71;
  if (bind(server, (const struct sockaddr *)&address, sizeof(address)) != 0 ||
      chmod(argv[2], 0600) != 0 || listen(server, 8) != 0) {
    close(server);
    return 71;
  }
  printf("resident example ready pid=%ld\n", (long)getpid());
  fflush(stdout);
  for (;;) {
    int client = accept(server, NULL, NULL);
    if (client < 0) {
      if (errno == EINTR) continue;
      close(server);
      return 71;
    }
    struct timeval timeout = {.tv_sec = 0, .tv_usec = 100000};
    if (setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0) {
      char request[7] = {0};
      size_t received = 0;
      while (received < 7) {
        ssize_t count = read(client, request + received, 7 - received);
        if (count <= 0) break;
        received += (size_t)count;
      }
      if (received == 7 && memcmp(request, "ready?\n", 7) == 0) {
        if (write(client, "ready\n", 6) == 6 && scheduled) {
          close(client);
          close(server);
          if (unlink(argv[2]) != 0) return 73;
          puts("scheduled example completed");
          return 0;
        }
      }
    }
    close(client);
  }
}
