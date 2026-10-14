#define _DARWIN_C_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <poll.h>
#include <fcntl.h>
#include <signal.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* Deliberately a fixture, not an implementation of merged ctl. */
static char root[PATH_MAX], lock_path[PATH_MAX], executable[PATH_MAX];
static pid_t active_child = -1;
static pid_t protected_child = -1;
static volatile sig_atomic_t terminated;
static const unsigned char secret[] = {0x91,0x52,0xa7,0x33,0x64,0x08,0xfd,0x21,0xc5,0x72,0x49,0xe6};
static unsigned assertions;

static void cleanup(void) {
    if (active_child > 0) {
        kill(active_child, SIGKILL);
        while (waitpid(active_child, NULL, 0) < 0 && errno == EINTR) {}
        active_child = -1;
    }
    if (protected_child > 0) {
        kill(protected_child, SIGKILL);
        while (waitpid(protected_child, NULL, 0) < 0 && errno == EINTR) {}
        protected_child = -1;
    }
    if (lock_path[0]) unlink(lock_path);
    if (root[0]) rmdir(root);
}
static void admit_inherited(const char *verb, int owner) {
    pid_t child = fork();
    if (child < 0) {
        cleanup();
        exit(1);
    }
    if (!child) {
        char number[32];
        snprintf(number, sizeof(number), "%d", owner);
        execl(executable, executable, verb, "--lifecycle-fd", number,
              "--lock-path", lock_path, (char *)NULL);
        _exit(75);
    }
    active_child = child;
    int status;
    while (waitpid(child, &status, 0) < 0) {
        if (errno != EINTR) {
            cleanup();
            exit(1);
        }
    }
    active_child = -1;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "FAIL inherited %s admission\n", verb);
        cleanup();
        exit(1);
    }
    ++assertions;
    printf("PASS %s admits parent's inherited --lifecycle-fd\n", verb);
}
static void fail(const char *what) {
    fprintf(stderr, "FAIL %s (errno=%d)\n", what, errno);
    cleanup();
    exit(1);
}
static void check(int ok, const char *what) {
    if (!ok) fail(what);
    ++assertions;
    printf("PASS %s\n", what);
    fflush(stdout);
}
static void timeout_handler(int sig) {
    (void)sig;
    cleanup();
    _exit(124);
}
static void term_handler(int sig) { (void)sig; terminated = 1; }
static void send_byte(int fd, char b) {
    ssize_t n;
    do { n = write(fd, &b, 1); } while (n < 0 && errno == EINTR);
    if (n != 1) fail("synchronization write");
}
static char receive_byte(int fd) {
    struct pollfd p = {fd, POLLIN, 0};
    int n;
    do { n = poll(&p, 1, 3000); } while (n < 0 && errno == EINTR);
    if (n != 1) fail("bounded synchronization poll");
    char b;
    do { n = (int)read(fd, &b, 1); } while (n < 0 && errno == EINTR);
    if (n != 1) fail("synchronization read");
    return b;
}
static int reap(pid_t child) {
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) fail("waitpid");
    active_child = -1;
    return status;
}
static int descriptor(const char *s) {
    char *end;
    errno = 0;
    long n = strtol(s, &end, 10);
    if (errno || !s[0] || *end || n < 0 || n > INT_MAX) return -1;
    return (int)n;
}
/* flock ownership is the open file description, not the descriptor number. */
static int validate_lifecycle_fd(int fd, const char *path) {
    struct stat a, b;
    if (fd < 0 || fstat(fd, &a) || stat(path, &b) || !S_ISREG(a.st_mode) ||
        a.st_dev != b.st_dev || a.st_ino != b.st_ino) return 64;
    if (flock(fd, LOCK_EX | LOCK_NB)) return errno == EWOULDBLOCK ? 73 : 74;
    return 0;
}
static void exec_competitor(const char *verb, int parent_fd) {
    close(parent_fd); /* Must not accidentally inherit the owner's description. */
    int fd = open(lock_path, O_RDWR);
    if (fd < 0) _exit(74);
    char number[32];
    snprintf(number, sizeof(number), "%d", fd);
    execl(executable, executable, verb, "--lifecycle-fd", number,
          "--lock-path", lock_path, (char *)NULL);
    _exit(75);
}
static void competitor(int owner, const char *verb, int expected) {
    pid_t child = fork();
    if (child < 0) fail("fork competitor");
    if (!child) exec_competitor(verb, owner);
    active_child = child;
    int status = reap(child);
    check(WIFEXITED(status) && WEXITSTATUS(status) == expected,
          expected == 73 ? (strcmp(verb, "install-host") == 0 ?
          "install-host --lifecycle-fd excluded" : "select-generation --lifecycle-fd excluded") :
          "competitor acquires after final parent close");
}
static int own_lock(void) {
    int fd = open(lock_path, O_CREAT | O_RDWR, 0600);
    if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB)) fail("acquire lifecycle lock");
    return fd;
}
static void inherited_lifecycle(void) {
    int owner = own_lock(), ready[2];
    if (pipe(ready)) fail("pipe");
    pid_t child = fork();
    if (child < 0) fail("fork hold helper");
    if (!child) {
        close(ready[0]);
        char fd[32], ack[32];
        snprintf(fd, sizeof(fd), "%d", owner);
        snprintf(ack, sizeof(ack), "%d", ready[1]);
        execl(executable, executable, "hold", "--lifecycle-fd", fd,
              "--lock-path", lock_path, "--ready-fd", ack, (char *)NULL);
        _exit(75);
    }
    active_child = child;
    close(ready[1]);
    check(receive_byte(ready[0]) == 'R', "exec helper validates inherited lifecycle fd");
    close(ready[0]);
    if (kill(child, SIGKILL)) fail("kill helper");
    int status = reap(child);
    check(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL, "helper killed by SIGKILL");
    admit_inherited("install-host", owner);
    admit_inherited("select-generation", owner);
    competitor(owner, "install-host", 73);
    competitor(owner, "select-generation", 73);
    check(close(owner) == 0, "parent closes final lock reference");
    competitor(-1, "install-host", 0);
    competitor(-1, "select-generation", 0);
}
static int64_t monotonic_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) fail("monotonic clock");
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
/* Event receipt and commit are distinct: cancellation must not release the lock. */
static void protected_worker(int owner, int gate, int event, int client, int mode) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = term_handler;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGTERM, &action, NULL)) _exit(76);
    send_byte(event, 'R');
    int64_t deadline = monotonic_ms() + 80;
    for (;;) {
        if (mode == 0 && terminated) break;
        if (mode == 1 && monotonic_ms() >= deadline) break;
        struct pollfd p = {client, POLLIN | POLLHUP, 0};
        int n = poll(&p, 1, mode == 1 ? 10 : 100);
        if (n < 0 && errno != EINTR) _exit(77);
        if (mode == 2 && n > 0) {
            char b;
            if (read(client, &b, 1) == 0) break;
            _exit(78);
        }
    }
    send_byte(event, 'D'); /* cancellation/deadline/disconnect observed; still protected */
    if (receive_byte(gate) != 'C') _exit(79);
    const char committed[] = "committed";
    if (pwrite(owner, committed, sizeof(committed), 0) != (ssize_t)sizeof(committed) ||
        fsync(owner)) _exit(80);
    send_byte(event, 'C'); /* protected commit completes before exiting */
    close(owner);
    close(gate);
    close(event);
    close(client);
    _exit(0);
}
static void protected_case(int mode) {
    int owner = own_lock(), gate[2], event[2], client[2];
    if (ftruncate(owner, 0)) fail("reset protected commit marker");
    if (pipe(gate) || pipe(event) || socketpair(AF_UNIX, SOCK_STREAM, 0, client)) fail("protected channels");
    pid_t child = fork();
    if (child < 0) fail("fork protected action");
    if (!child) {
        close(gate[1]); close(event[0]); close(client[0]);
        protected_worker(owner, gate[0], event[1], client[1], mode);
    }
    protected_child = child;
    close(gate[0]); close(event[1]); close(client[1]);
    check(receive_byte(event[0]) == 'R', "protected action enters critical section");
    if (mode == 0 && kill(child, SIGTERM)) fail("SIGTERM delivery");
    if (mode == 2) { close(client[0]); client[0] = -1; }
    check(receive_byte(event[0]) == 'D', mode == 0 ? "SIGTERM observed and deferred" :
          mode == 1 ? "monotonic deadline expires without aborting action" :
          "client EOF observed without aborting action");
    competitor(owner, "install-host", 73);
    competitor(owner, "select-generation", 73);
    send_byte(gate[1], 'C');
    check(receive_byte(event[0]) == 'C', "protected action commits after cancellation event");
    int status = reap(child);
    protected_child = -1;
    check(WIFEXITED(status) && WEXITSTATUS(status) == 0, "protected worker exits normally");
    char committed[10];
    check(pread(owner, committed, sizeof(committed), 0) == (ssize_t)sizeof(committed) &&
          !memcmp(committed, "committed", sizeof(committed)),
          "durable protected commit marker verified after worker exit");
    competitor(owner, "install-host", 73);
    close(owner);
    competitor(-1, "select-generation", 0);
    close(gate[1]); close(event[0]); if (client[0] >= 0) close(client[0]);
}
static int fd_count(void) {
    struct proc_fdinfo fds[4096];
    int n = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, fds, sizeof(fds));
    if (n <= 0 || n >= (int)sizeof(fds) || n % (int)sizeof(fds[0])) fail("complete fd census");
    return n / (int)sizeof(fds[0]);
}
static int contains(const unsigned char *hay, size_t length) {
    for (size_t i = 0; i + sizeof(secret) <= length; ++i)
        if (!memcmp(hay + i, secret, sizeof(secret))) return 1;
    return 0;
}
/* XNU UIPC_MAX_CMSG_FD=512. Receive the whole possible rights batch:
 * Darwin installs rights before copyout; a tiny truncated buffer loses fd numbers.
 * Exactly one is allowed; every other delivered right is closed, not ignored. */
enum { darwin_max_rights = 512 };
static int receive_secret(int socket_fd, int report_fd) {
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(darwin_max_rights * sizeof(int))]; } control;
    unsigned char payload[8];
    struct iovec iov = {payload, sizeof(payload)};
    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    memset(&control, 0, sizeof(control));
    msg.msg_iov = &iov; msg.msg_iovlen = 1;
    msg.msg_control = control.bytes; msg.msg_controllen = sizeof(control.bytes);
    ssize_t n = recvmsg(socket_fd, &msg, 0);
    int rights[2], count = 0, malformed = 0;
    /* Darwin may retain the original cmsg_len on ancillary truncation.
     * Never interpret bytes outside the actual receive buffer as descriptors. */
    size_t available = msg.msg_controllen < sizeof(control.bytes) ?
        msg.msg_controllen : sizeof(control.bytes);
    unsigned char *cursor = control.bytes, *end = control.bytes + available;
    while ((size_t)(end - cursor) >= sizeof(struct cmsghdr)) {
        struct cmsghdr *c = (struct cmsghdr *)cursor;
        size_t remaining = (size_t)(end - cursor);
        if (c->cmsg_len < CMSG_LEN(0)) { malformed = 1; break; }
        size_t length = c->cmsg_len;
        if (length > remaining) { length = remaining; malformed = 1; }
        if (c->cmsg_level == SOL_SOCKET && c->cmsg_type == SCM_RIGHTS &&
            length >= CMSG_LEN(0)) {
            size_t bytes = length - CMSG_LEN(0);
            if (bytes % sizeof(int)) malformed = 1;
            for (size_t i = 0; i < bytes / sizeof(int); ++i) {
                int fd;
                memcpy(&fd, (unsigned char *)CMSG_DATA(c) + i * sizeof(int), sizeof(fd));
                if (count < 2) rights[count++] = fd;
                else { close(fd); malformed = 1; }
            }
        } else malformed = 1;
        if (c->cmsg_len > remaining) break;
        size_t step = CMSG_SPACE(c->cmsg_len - CMSG_LEN(0));
        if (step > remaining) break;
        cursor += step;
    }
    int accepted = n == 1 && payload[0] == 'S' && count == 1 && !malformed &&
        !(msg.msg_flags & (MSG_CTRUNC | MSG_TRUNC));
    if (accepted) {
        struct stat st;
        int flags = fcntl(rights[0], F_GETFL);
        accepted = !fstat(rights[0], &st) && S_ISFIFO(st.st_mode) &&
            flags >= 0 && (flags & O_ACCMODE) == O_RDONLY;
        if (accepted) {
            unsigned char bytes[sizeof(secret) + 1];
            accepted = fcntl(rights[0], F_SETFL, flags | O_NONBLOCK) == 0;
            ssize_t got = accepted ? read(rights[0], bytes, sizeof(bytes)) : -1;
            accepted = got == (ssize_t)sizeof(secret) && !memcmp(bytes, secret, sizeof(secret));
            memset(bytes, 0, sizeof(bytes));
        }
    }
    for (int i = 0; i < count; ++i) close(rights[i]);
    const char *report = accepted ? "secret accepted\n{\"accepted\":true,\"secret_fd_count\":1}\n" :
        "secret rejected\n{\"accepted\":false}\n";
    if (write(report_fd, report, strlen(report)) != (ssize_t)strlen(report)) fail("redacted report write");
    return accepted;
}
static void secret_case(int kind) {
    static const char *names[] = {"single SCM_RIGHTS secret fd accepted", "missing fd rejected",
        "extra fds rejected", "socket descriptor rejected", "writable pipe rejected",
        "malformed payload rejected", "oversized ancillary batch rejected without truncation",
        "truncated message payload rejected and its rights closed"};
    int baseline = fd_count(), socket_pair[2], secret_pipe[2], report[2];
    if (socketpair(AF_UNIX, SOCK_DGRAM, 0, socket_pair) || pipe(secret_pipe) || pipe(report)) fail("secret channels");
    if (write(secret_pipe[1], secret, sizeof(secret)) != (ssize_t)sizeof(secret)) fail("synthetic secret write");
    close(secret_pipe[1]); secret_pipe[1] = -1;
    int rights[8], count = kind == 1 ? 0 : kind == 2 ? 2 : kind == 6 ? 8 : 1;
    for (int i = 0; i < count; ++i) rights[i] = secret_pipe[0];
    int malformed_pipe[2] = {-1, -1};
    if (kind == 3) rights[0] = socket_pair[0];
    if (kind == 4) {
        if (pipe(malformed_pipe)) fail("malformed pipe");
        rights[0] = malformed_pipe[1];
    }
    union { struct cmsghdr alignment; unsigned char bytes[CMSG_SPACE(8 * sizeof(int))]; } control;
    memset(&control, 0, sizeof(control));
    char payload[9] = {0}; payload[0] = kind == 5 ? 'X' : 'S';
    struct iovec iov = {payload, kind == 7 ? sizeof(payload) : 1};
    struct msghdr msg;
    memset(&msg, 0, sizeof(msg));
    msg.msg_iov = &iov; msg.msg_iovlen = 1;
    if (count) {
        msg.msg_control = control.bytes; msg.msg_controllen = CMSG_SPACE((size_t)count * sizeof(int));
        struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
        c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS;
        c->cmsg_len = CMSG_LEN((size_t)count * sizeof(int));
        memcpy(CMSG_DATA(c), rights, (size_t)count * sizeof(int));
    }
    if (sendmsg(socket_pair[0], &msg, 0) != (ssize_t)iov.iov_len) fail("SCM_RIGHTS sendmsg");
    int before_receive = fd_count();
    int accepted = receive_secret(socket_pair[1], report[1]);
    check(accepted == (kind == 0), names[kind]);
    check(fd_count() == before_receive, "receiver closes every delivered descriptor");
    close(report[1]);
    unsigned char output[256];
    ssize_t length = read(report[0], output, sizeof(output));
    check(length > 0 && !contains(output, (size_t)length), "actual receiver log and ctl JSON contain no secret bytes");
    close(report[0]); close(secret_pipe[0]); close(socket_pair[0]); close(socket_pair[1]);
    if (malformed_pipe[0] >= 0) { close(malformed_pipe[0]); close(malformed_pipe[1]); }
    check(fd_count() == baseline, "whole secret case restores fd census");
    printf("EVIDENCE secret_case=%d fd_before=%d fd_after=%d accepted=%d\n", kind, baseline, fd_count(), accepted);
}
int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "suite")) {
        int fd = -1, ready = -1;
        const char *path = NULL;
        for (int i = 2; i + 1 < argc; i += 2) {
            if (!strcmp(argv[i], "--lifecycle-fd")) fd = descriptor(argv[i + 1]);
            else if (!strcmp(argv[i], "--ready-fd")) ready = descriptor(argv[i + 1]);
            else if (!strcmp(argv[i], "--lock-path")) path = argv[i + 1];
            else return 64;
        }
        if (argc % 2 != 0 || !path) return 64;
        int result = validate_lifecycle_fd(fd, path);
        if (result) { if (fd >= 0) close(fd); return result; }
        if (!strcmp(argv[1], "hold") && ready >= 0) {
            send_byte(ready, 'R'); close(ready);
            for (;;) pause();
        }
        if (strcmp(argv[1], "install-host") && strcmp(argv[1], "select-generation")) { close(fd); return 64; }
        close(fd);
        return 0;
    }
    if (argc != 2) { fprintf(stderr, "usage: %s suite\n", argv[0]); return 64; }
    if (!realpath(argv[0], executable)) fail("resolve executable path");
    snprintf(root, sizeof(root), "/tmp/m3-e5-XXXXXX");
    if (!mkdtemp(root)) { root[0] = 0; fail("temporary directory"); }
    snprintf(lock_path, sizeof(lock_path), "%s/lifecycle.lock", root);
    atexit(cleanup);
    signal(SIGALRM, timeout_handler);
    signal(SIGPIPE, SIG_IGN);
    alarm(30);
    int initial_fds = fd_count();
    inherited_lifecycle();
    for (int mode = 0; mode < 3; ++mode) protected_case(mode);
    for (int i = 0; i < argc; ++i)
        check(!contains((const unsigned char *)argv[i], strlen(argv[i])), "process argv contains no synthetic secret");
    for (int kind = 0; kind < 8; ++kind) secret_case(kind);
    check(fd_count() == initial_fds, "complete suite restores initial fd census");
    alarm(0);
    cleanup();
    check(access(root, F_OK) < 0 && errno == ENOENT, "temporary files and directory removed");
    printf("PASS E5 fixture assertions=%u; merged_ctl_exercised=false\n", assertions);
    return 0;
}
