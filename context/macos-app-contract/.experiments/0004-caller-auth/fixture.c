#define _DARWIN_C_SOURCE 1
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <mach/mach.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

/* These SPI declarations are resolved dynamically, never replaced by PID-only lookup. */
typedef OSStatus (*create_token_fn)(const audit_token_t *, SecCSFlags, SecCodeRef *);
typedef int (*csops_token_fn)(pid_t, unsigned int, void *, size_t, audit_token_t *);
enum { fixture_CS_OPS_STATUS = 0 };

static int fail(const char *stage) {
    fprintf(stderr, "ERROR stage=%s errno=%d\n", stage, errno);
    return 2;
}
static bool byte(int fd, char *value) {
    struct pollfd p = {.fd = fd, .events = POLLIN};
    int n;
    do { n = poll(&p, 1, 10000); } while (n < 0 && errno == EINTR);
    if (n != 1) return false;
    ssize_t r;
    do { r = read(fd, value, 1); } while (r < 0 && errno == EINTR);
    return r == 1;
}
static int socket_address(const char *path, struct sockaddr_un *address) {
    if (strlen(path) >= sizeof(address->sun_path)) { errno = ENAMETOOLONG; return -1; }
    memset(address, 0, sizeof(*address));
    address->sun_family = AF_UNIX;
    address->sun_len = sizeof(*address);
    strcpy(address->sun_path, path);
    return 0;
}
static OSStatus public_token_code(const audit_token_t *token, SecCodeRef *code) {
    CFDataRef data = CFDataCreate(NULL, (const UInt8 *)token, sizeof(*token));
    if (!data) return errSecAllocate;
    const void *key = kSecGuestAttributeAudit, *value = data;
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, &key, &value, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFRelease(data);
    if (!attributes) return errSecAllocate;
    OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, code);
    CFRelease(attributes);
    return status;
}
static int freshness(csops_token_fn fn, audit_token_t *token, const char *stage) {
    uint32_t flags = 0;
    errno = 0;
    int result = fn ? fn((pid_t)token->val[5], fixture_CS_OPS_STATUS,
                        &flags, sizeof(flags), token) : -1;
    int error = fn ? errno : ENOSYS;
    printf("FRESHNESS stage=%s rc=%d errno=%d csflags=%u\n", stage, result, error, flags);
    return result;
}
static int server(const char *path, const char *requirement_text, bool stale_version) {
    CFStringRef text = CFStringCreateWithCString(NULL, requirement_text, kCFStringEncodingUTF8);
    if (!text) return fail("requirement-string");
    SecRequirementRef requirement = NULL;
    OSStatus status = SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement);
    CFRelease(text);
    printf("REQUIREMENT status=%d\n", (int)status);
    if (status != errSecSuccess) return 2;
    create_token_fn create = (create_token_fn)dlsym(RTLD_DEFAULT, "SecCodeCreateWithAuditToken");
    csops_token_fn fresh = (csops_token_fn)dlsym(RTLD_DEFAULT, "csops_audittoken");
    printf("API requested_available=%d selected=%s freshness_available=%d\n", create != NULL,
           create ? "SecCodeCreateWithAuditToken" : "SecCodeCopyGuestWithAttributes.audit", fresh != NULL);
    if (!fresh) { CFRelease(requirement); return fail("freshness-api-unavailable"); }
    struct sockaddr_un address;
    if (socket_address(path, &address)) { CFRelease(requirement); return fail("address"); }
    int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (listener < 0) { CFRelease(requirement); return fail("socket"); }
    umask(077);
    /* Never unlink an existing socket: parent supplies a fresh private directory. */
    if (bind(listener, (struct sockaddr *)&address, sizeof(address))) {
        close(listener); CFRelease(requirement); return fail("bind");
    }
    int result = 2, peer = -1;
    if (listen(listener, 1)) { fail("listen"); goto done; }
    printf("READY\n");
    struct pollfd listening = {.fd = listener, .events = POLLIN};
    if (poll(&listening, 1, 10000) != 1) { fail("accept-timeout"); goto done; }
    peer = accept(listener, NULL, NULL);
    if (peer < 0) { fail("accept"); goto done; }
    audit_token_t token = {{0}};
    socklen_t length = sizeof(token);
    if (getsockopt(peer, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) || length != sizeof(token)) {
        fail("LOCAL_PEERTOKEN"); goto done;
    }
    /* Darwin audit-token ABI words: euid=1, ruid=3, pid=5, pidversion=7. */
    printf("CAPTURED token=[%u,%u,%u,%u,%u,%u,%u,%u] pid=%u pidversion=%u euid=%u ruid=%u server_uid=%u\n",
        token.val[0], token.val[1], token.val[2], token.val[3], token.val[4], token.val[5],
        token.val[6], token.val[7], token.val[5], token.val[7], token.val[1], token.val[3], getuid());
    if (write(peer, "C", 1) != 1) { fail("capture-notification"); goto done; }
    char gate;
    if (!byte(STDIN_FILENO, &gate) || gate != 'K') { fail("parent-check-gate"); goto done; }
    if (stale_version) {
        /* Bounded synthetic PID-reuse oracle: same PID, wrong incarnation.
         * This is not a claim that the kernel actually recycled this PID. */
        token.val[7] ^= 0x80000000u;
        printf("SYNTHETIC_PID_REUSE pid=%u stale_pidversion=%u\n", token.val[5], token.val[7]);
    }
    SecCodeRef code = NULL;
    OSStatus create_status = create ? create(&token, kSecCSDefaultFlags, &code) : public_token_code(&token, &code);
    OSStatus check_status = create_status;
    bool checked = create_status == errSecSuccess && code != NULL;
    if (checked) check_status = SecCodeCheckValidity(code, kSecCSStrictValidate | kSecCSNoNetworkAccess, requirement);
    if (code) CFRelease(code);
    bool same_uid = token.val[1] == getuid() && token.val[3] == getuid();
    printf("PRIMITIVE create_status=%d check_attempted=%d check_status=%d same_uid=%d primitive_accept=%d\n",
           (int)create_status, checked, (int)check_status, same_uid,
           checked && check_status == errSecSuccess && same_uid);
    int before = freshness(fresh, &token, "after-security");
    char hello = 0;
    bool live = byte(peer, &hello) && hello == 'H';
    printf("LIVENESS hello=%d\n", live);
    int after = freshness(fresh, &token, "before-admission");
    bool accepted = checked && check_status == errSecSuccess && same_uid && before == 0 && live && after == 0;
    printf("DECISION accepted=%d\n", accepted);
    (void)write(peer, accepted ? "A" : "D", 1);
    result = accepted ? 0 : 1;
done:
    if (peer >= 0) close(peer);
    close(listener);
    unlink(path);
    CFRelease(requirement);
    return result;
}
static int finish_client(int fd, bool inherited) {
    if (write(fd, "H", 1) != 1) return fail("hello");
    printf("%s pid=%d\n", inherited ? "EXECED" : "LIVE", getpid());
    char decision;
    if (!byte(fd, &decision)) return fail("decision");
    printf("CLIENT decision=%c\n", decision);
    close(fd);
    return decision == 'A' ? 0 : decision == 'D' ? 1 : 2;
}
static int client(int argc, char **argv) {
    struct sockaddr_un address;
    if (socket_address(argv[2], &address)) return fail("address");
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof(address))) return fail("connect");
    char captured;
    if (!byte(fd, &captured) || captured != 'C') return fail("capture-notification");
    if (!strcmp(argv[3], "exit")) { printf("EXITING pid=%d\n", getpid()); close(fd); return 0; }
    if (!strcmp(argv[3], "exec") && argc == 5) {
        if (fcntl(fd, F_SETFD, 0)) return fail("inherit-fd");
        char number[32]; snprintf(number, sizeof(number), "%d", fd);
        execl(argv[4], argv[4], "inherited", number, (char *)NULL);
        return fail("exec");
    }
    if (!strcmp(argv[3], "hold")) return finish_client(fd, false);
    close(fd); errno = EINVAL; return fail("client-mode");
}
int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IONBF, 0);
    signal(SIGPIPE, SIG_IGN);
    if (argc == 4 && !strcmp(argv[1], "server")) return server(argv[2], argv[3], false);
    if (argc == 4 && !strcmp(argv[1], "stale-version-server")) return server(argv[2], argv[3], true);
    if ((argc == 4 || argc == 5) && !strcmp(argv[1], "client")) return client(argc, argv);
    if (argc == 3 && !strcmp(argv[1], "inherited")) {
        char *end; long fd = strtol(argv[2], &end, 10);
        if (*end || fd < 0 || fd > INT32_MAX) return 2;
        return finish_client((int)fd, true);
    }
    fprintf(stderr, "usage: fixture server SOCKET REQUIREMENT | client SOCKET hold|exit|exec [TARGET] | inherited FD\n");
    return 2;
}
