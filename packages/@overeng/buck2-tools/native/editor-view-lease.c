#define _GNU_SOURCE
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#ifdef __APPLE__
#include <sys/mount.h>
#include <libproc.h>
#include <sys/proc_info.h>
#else
#include <sys/vfs.h>
#endif
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Bun FFI must never call variadic libc entrypoints directly: Darwin arm64
 * passes variadic arguments on the stack, unlike fixed-arity arguments. */
int eu_dupfd_cloexec(int fd, int minimum) {
  return fcntl(fd, F_DUPFD_CLOEXEC, minimum);
}
int eu_getfd(int fd) {
  return fcntl(fd, F_GETFD);
}

/* An lsof "(revoked)" name alone is heuristic, never sufficient proof.
 * Confirm the kernel's vnode type and both pathless/pathful ENOENT results.
 * Live APFS unlinked files, removed directories and renamed parents retain
 * vnode identity; a force-unmounted APFS vnode gives this paired result and EIO.
 * Any other state or failed observation stays unknown (return zero). */
int eu_darwin_dead_vnode(int pid, int fd) {
#ifdef __APPLE__
  if (pid <= 0 || fd < 0) return 0;
  int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
  if (bytes <= 0 || bytes > INT_MAX - (int)sizeof(struct proc_fdinfo)) return 0;
  bytes += (int)sizeof(struct proc_fdinfo);
  struct proc_fdinfo *entries = malloc((size_t)bytes);
  if (!entries) return 0;
  int used = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, entries, bytes);
  int vnode = 0;
  if (used > 0 && used <= bytes && used % (int)sizeof(*entries) == 0) {
    for (int i = 0; i < used / (int)sizeof(*entries); i++) {
      if (entries[i].proc_fd == fd && entries[i].proc_fdtype == PROX_FDTYPE_VNODE) {
        vnode = 1;
        break;
      }
    }
  }
  free(entries);
  if (!vnode) return 0;
  struct vnode_fdinfo info;
  struct vnode_fdinfowithpath path;
  errno = 0;
  int simple = proc_pidfdinfo(pid, fd, PROC_PIDFDVNODEINFO, &info, sizeof(info));
  int simple_error = errno;
  errno = 0;
  int named = proc_pidfdinfo(pid, fd, PROC_PIDFDVNODEPATHINFO, &path, sizeof(path));
  int named_error = errno;
  return simple == 0 && simple_error == ENOENT && named == 0 && named_error == ENOENT;
#else
  (void)pid;
  (void)fd;
  return 0;
#endif
}

#ifndef EU_LEASE_FFI

/* Independent of Bun, node_modules and every evictable editor generation.
 * Missing controls are lazily created only inside the owning CAS fence.
 * Zero-generation inventory opens and creates no CAS fence. */
static void die(const char *message, const char *path) {
  fprintf(stderr, "editor-view-lease: %s: %s (%s)\n", message, path, strerror(errno));
  exit(1);
}
static void pathcat(char out[PATH_MAX], const char *left, const char *right) {
  if (snprintf(out, PATH_MAX, "%s/%s", left, right) >= PATH_MAX) die("path too long", left);
}
static int same(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static void directory(const char *path, int private) {
  struct stat s; char canonical[PATH_MAX];
  if (lstat(path, &s) || !S_ISDIR(s.st_mode) || s.st_uid != getuid() ||
      (s.st_mode & (private ? 077 : 022)) || !realpath(path, canonical) || strcmp(path, canonical))
    die("unsafe directory", path);
}
static void localfs(const char *path) {
  struct statfs fs;
  if (statfs(path, &fs)) die("cannot classify filesystem", path);
#ifdef __APPLE__
  if (strcmp(fs.f_fstypename, "apfs") && strcmp(fs.f_fstypename, "hfs")) die("unknown filesystem", path);
#else
  switch ((uint32_t)fs.f_type) {
    case 0xef53: case 0x58465342: case 0x9123683e: case 0x01021994: case 0x858458f6: case 0x2fc12fc1: break;
    default: die("unknown filesystem", path);
  }
#endif
}
static void control(const char *path, int fd) {
  struct stat a, b;
  if (fstat(fd, &a) || lstat(path, &b) || !same(&a, &b) || !S_ISREG(a.st_mode) ||
      a.st_uid != getuid() || a.st_nlink != 1 || b.st_nlink != 1 || (a.st_mode & 0777) != 0600 || a.st_size > 8192)
    die("unsafe or replaced control", path);
}
static void lockfd(int fd, int mode, const char *path) {
  int result;
  do { result = flock(fd, mode); } while (result && errno == EINTR);
  if (result) die("cannot acquire lock", path);
}
struct lease { int fd; dev_t dev; ino_t ino; };
static struct lease *leases; static size_t count, leaseCapacity;
static void retain(int fd) {
  struct stat status; if(fstat(fd,&status)) die("cannot stat retained descriptor","leases");
  for(size_t i=0;i<count;i++) {
    if(leases[i].dev==status.st_dev && leases[i].ino==status.st_ino) {
      if(leases[i].fd!=fd && close(fd)) die("cannot close duplicate lease","leases");
      return;
    }
  }
  if(count==leaseCapacity) {
    leaseCapacity=leaseCapacity?leaseCapacity*2:8;
    struct lease *next=realloc(leases,leaseCapacity*sizeof(*leases));
    if(!next) die("allocation failure","leases");
    leases=next;
  }
  leases[count++]=(struct lease){fd,status.st_dev,status.st_ino};
}
static void defaultCloseOnExec(void) {
#ifdef __APPLE__
  const char *path="/dev/fd";
#else
  const char *path="/proc/self/fd";
#endif
  DIR *dir=opendir(path); if(!dir) die("cannot enumerate inherited descriptors",path);
  struct dirent *entry; errno=0;
  while((entry=readdir(dir))) {
    char *end; long fd=strtol(entry->d_name,&end,10);
    if(*entry->d_name && !*end && fd>=3 && fd<=INT_MAX) {
      int flags=fcntl((int)fd,F_GETFD);
      if(flags<0 || fcntl((int)fd,F_SETFD,flags|FD_CLOEXEC)) die("cannot protect inherited descriptor",entry->d_name);
    }
    errno=0;
  }
  if(errno) die("incomplete descriptor enumeration",path);
  if(closedir(dir)) die("cannot close descriptor directory",path);
}
static void leaseIdentity(const char *path, int fd, const char *root, const char *name) {
  struct stat s; char actual[8192], expected[8192];
  if (fstat(fd, &s)) die("cannot stat lease",path);
  int length=snprintf(expected,sizeof(expected),"%ju:%ju\n%s\n%s\n",(uintmax_t)s.st_dev,(uintmax_t)s.st_ino,root,name);
  if(length<0 || length>=(int)sizeof(expected) || s.st_size!=length || pread(fd,actual,(size_t)length,0)!=length || memcmp(actual,expected,(size_t)length))
    die("replaced lease identity",path);
}
static void generation(const char *root, const char *name) {
  localfs(root);
  char store[PATH_MAX], snapshot[PATH_MAX], leaseDir[PATH_MAX], controlPath[PATH_MAX], lockname[PATH_MAX];
  struct stat before, after;
  pathcat(store, root, ".store"); directory(store, 0);
  pathcat(snapshot, store, name); directory(snapshot, 0); localfs(snapshot);
  if (lstat(snapshot, &before)) die("generation disappeared", snapshot);
  pathcat(leaseDir, root, ".leases");
  if(mkdir(leaseDir,0700) && errno!=EEXIST) die("cannot create private lease directory",leaseDir);
  directory(leaseDir, 1);
  if (snprintf(lockname, sizeof(lockname), "%s.lock", name) >= (int)sizeof(lockname)) die("generation too long", name);
  pathcat(controlPath, leaseDir, lockname);
  int created=0;
  int fd=open(controlPath,O_RDWR|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC|O_CREAT|O_EXCL,0600);
  if(fd>=0) created=1;
  else if(errno==EEXIST) fd=open(controlPath,O_RDWR|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);
  if (fd < 0) die("missing lease control", controlPath);
  control(controlPath, fd);
  if(created) {
    struct stat status; char identity[8192];
    if(fstat(fd,&status)) die("cannot identify new control",controlPath);
    int length=snprintf(identity,sizeof(identity),"%ju:%ju\n%s\n%s\n",(uintmax_t)status.st_dev,(uintmax_t)status.st_ino,root,name);
    if(length<0 || length>=(int)sizeof(identity)) die("lease identity too long",controlPath);
    size_t offset=0;
    while(offset<(size_t)length) {
      ssize_t written=pwrite(fd,identity+offset,(size_t)length-offset,(off_t)offset);
      if(written<0 && errno==EINTR) continue;
      if(written<=0) die("cannot write new control identity",controlPath);
      offset+=(size_t)written;
    }
  }
  leaseIdentity(controlPath,fd,root,name);
  lockfd(fd, LOCK_SH | LOCK_NB, controlPath);
  control(controlPath, fd);
  leaseIdentity(controlPath,fd,root,name);
  if (lstat(snapshot, &after) || !same(&before, &after)) die("generation replaced", snapshot);
  retain(fd);
}
static void editorrootContents(const char *root) {
  directory(root, 0);
  DIR *dir = opendir(root); if (!dir) die("cannot enumerate editor root", root);
  struct dirent *entry;
  errno = 0;
  while ((entry = readdir(dir))) {
    if (entry->d_name[0] == '.') continue;
    char pointer[PATH_MAX], target[PATH_MAX], store[PATH_MAX]; struct stat s;
    pathcat(pointer, root, entry->d_name);
    if (lstat(pointer, &s)) die("cannot inspect view pointer", pointer);
    if (!S_ISLNK(s.st_mode)) continue;
    if (!realpath(pointer, target)) die("cannot resolve view pointer", pointer);
    pathcat(store, root, ".store"); size_t n = strlen(store);
    if (strncmp(target, store, n) || target[n] != '/' || !target[n+1] || strchr(target+n+1, '/')) die("view pointer outside store", pointer);
    generation(root, target+n+1);
    char checked[PATH_MAX]; if (!realpath(pointer, checked) || strcmp(target, checked)) die("view pointer changed", pointer);
    errno = 0;
  }
  if (errno) die("incomplete editor root discovery", root);
  if (closedir(dir)) die("cannot close editor root", root);
}
static const char *storeOverride;
static void parentPath(char path[PATH_MAX]) {
  char *slash=strrchr(path,'/');
  if(!slash || slash==path) { path[0]='/'; path[1]=0; }
  else *slash=0;
}
static int textFile(const char *path, char text[PATH_MAX]) {
  int fd=open(path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
  if(fd<0) { if(errno==ENOENT) return 0; die("cannot read Git ownership",path); }
  struct stat status;
  if(fstat(fd,&status) || !S_ISREG(status.st_mode) || status.st_size<=0 || status.st_size>=PATH_MAX) die("invalid Git ownership file",path);
  ssize_t length=pread(fd,text,(size_t)status.st_size,0);
  if(length!=status.st_size || close(fd)) die("incomplete Git ownership file",path);
  while(length>0 && (text[length-1]=='\n' || text[length-1]=='\r')) length--;
  text[length]=0;
  if(!length || strchr(text,'\n') || strchr(text,'\r')) die("invalid Git ownership text",path);
  return 1;
}
static void resolveFrom(char output[PATH_MAX], const char *base, const char *value) {
  char path[PATH_MAX];
  if(value[0]=='/') {
    if(snprintf(path,sizeof(path),"%s",value)>=(int)sizeof(path)) die("path too long",value);
  } else pathcat(path,base,value);
  if(!realpath(path,output)) die("cannot resolve Git ownership",path);
}
static void owningStore(const char *root, char output[PATH_MAX]) {
  if(storeOverride) {
    if(storeOverride[0]!='/' || !realpath(storeOverride,output) || strcmp(storeOverride,output)) die("noncanonical explicit content store",storeOverride);
    return;
  }
  char ancestor[PATH_MAX]; snprintf(ancestor,sizeof(ancestor),"%s",root); parentPath(ancestor);
  for(;;) {
    char git[PATH_MAX], common[PATH_MAX], path[PATH_MAX], text[PATH_MAX]; struct stat status;
    pathcat(path,ancestor,".git");
    if(lstat(path,&status)==0) {
      if(S_ISDIR(status.st_mode)) {
        if(!realpath(path,git)) die("cannot resolve Git directory",path);
      } else if(S_ISREG(status.st_mode)) {
        if(!textFile(path,text) || strncmp(text,"gitdir: ",8) || !text[8]) die("invalid Git gitdir file",path);
        resolveFrom(git,ancestor,text+8);
      } else die("unsafe Git ownership entry",path);
      pathcat(path,git,"commondir");
      if(textFile(path,text)) resolveFrom(common,git,text);
      else snprintf(common,sizeof(common),"%s",git);
      directory(common,0); parentPath(common);
      pathcat(path,common,".editor-view-content/v1");
      if(!realpath(path,output)) die("missing owning content store",path);
      return;
    }
    if(errno!=ENOENT) die("unknown Git ownership",path);
    if(!strcmp(ancestor,"/")) break;
    parentPath(ancestor);
  }
  const char *home=getenv("HOME");
  if(!home || home[0]!='/') die("unknown content-store home",root);
  char fallback[PATH_MAX]; pathcat(fallback,home,".cache/effect-utils/editor-view-content/v1");
  if(!realpath(fallback,output)) die("missing fallback content store",fallback);
}
static void editorroot(const char *root) {
  directory(root,0);
  struct stat rootIdentity, admittedRoot;
  if(lstat(root,&rootIdentity)) die("cannot identify editor root",root);
  DIR *dir=opendir(root); if(!dir) die("cannot inventory editor root",root);
  int published=0; struct dirent *entry; errno=0;
  while((entry=readdir(dir))) {
    if(entry->d_name[0]=='.') continue;
    char path[PATH_MAX]; struct stat status; pathcat(path,root,entry->d_name);
    if(lstat(path,&status)) die("incomplete editor root inventory",path);
    if(S_ISLNK(status.st_mode)) published=1;
    errno=0;
  }
  if(errno || closedir(dir)) die("incomplete editor root inventory",root);
  if(!published) return; /* Cold roots need no fence and create none. */
  char store[PATH_MAX], checked[PATH_MAX], fence[PATH_MAX], parent[PATH_MAX];
  owningStore(root,store);
  if(snprintf(fence,sizeof(fence),"%s.flock",store)>=(int)sizeof(fence)) die("path too long",store);
  snprintf(parent,sizeof(parent),"%s",store); parentPath(parent); directory(parent,0); localfs(parent);
  int cas=open(fence,O_RDWR|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC);
  if(cas<0) die("missing owning CAS fence",fence);
  control(fence,cas); lockfd(cas,LOCK_EX,fence); control(fence,cas);
  owningStore(root,checked);
  if(strcmp(store,checked) || lstat(root,&admittedRoot) || !same(&rootIdentity,&admittedRoot)) die("editor ownership changed during admission",root);
  char marker; struct stat status;
  if(fstat(cas,&status) || status.st_size!=1 || pread(cas,&marker,1,0)!=1 || marker!='0') die("owning CAS needs publisher repair before launch",fence);
  editorrootContents(root);
  /* Close only: LOCK_UN could drop protection held by inheritors. */
  if(close(cas)) die("cannot close owning CAS fence",fence);
}
static int skip(const char *name) {
  return !strcmp(name,".") || !strcmp(name,"..") || !strcmp(name,".git") || !strcmp(name,"node_modules") ||
    !strcmp(name,".store") || !strcmp(name,".leases") || !strcmp(name,".cache") || !strcmp(name,"buck-out") ||
    !strcmp(name,".devenv") || !strcmp(name,".direnv") || !strcmp(name,"tmp") || !strcmp(name,"target");
}
struct visitedDirectory { dev_t dev; ino_t ino; };
static struct visitedDirectory *visited; static size_t visitedCount, visitedCapacity;
static void workspace(const char *root) {
  struct stat identity;
  if(stat(root,&identity)) die("cannot identify workspace directory",root);
  for(size_t i=0;i<visitedCount;i++) if(visited[i].dev==identity.st_dev && visited[i].ino==identity.st_ino) return;
  if(visitedCount==visitedCapacity) {
    visitedCapacity=visitedCapacity?visitedCapacity*2:64;
    struct visitedDirectory *next=realloc(visited,visitedCapacity*sizeof(*visited));
    if(!next) die("allocation failure","workspace discovery");
    visited=next;
  }
  visited[visitedCount++]=(struct visitedDirectory){identity.st_dev,identity.st_ino};
  DIR *dir = opendir(root); if (!dir) die("cannot enumerate workspace", root);
  struct dirent *entry; errno = 0;
  while ((entry = readdir(dir))) {
    if (skip(entry->d_name)) continue;
    char child[PATH_MAX]; struct stat s; pathcat(child,root,entry->d_name);
    if (lstat(child,&s)) die("cannot inspect workspace entry", child);
    if (S_ISLNK(s.st_mode)) {
      struct stat target;
      if (!strcmp(entry->d_name,".editor-view")) die("symlink editor root",child);
      if (stat(child,&target)) {
        if(errno!=ENOENT) die("cannot classify workspace symlink",child);
      } else if(S_ISDIR(target.st_mode)) {
        char canonical[PATH_MAX];
        if(!realpath(child,canonical)) die("cannot resolve workspace directory",child);
        workspace(canonical);
      }
    }
    if (S_ISDIR(s.st_mode)) {
      if (!strcmp(entry->d_name,".editor-view")) editorroot(child);
      else workspace(child);
    }
    errno = 0;
  }
  if (errno) die("incomplete workspace discovery", root);
  if (closedir(dir)) die("cannot close workspace directory", root);
}
static void discover(int argc, char **argv, int command, int trampolineMode, const char *workspaceRoot) {
  char canonical[PATH_MAX];
  visitedCount=0;
  if(trampolineMode) {
    if(!realpath(workspaceRoot,canonical)) die("invalid workspace",workspaceRoot);
    workspace(canonical);
  } else {
    int roots=0;
    if(!command || command>=argc) die("root and command required","arguments");
    for(int i=1;i<command-1;i+=2) {
      if(!strcmp(argv[i],"--content-store")) continue;
      if(!realpath(argv[i+1],canonical)) die("invalid root",argv[i+1]);
      if(!strcmp(argv[i],"--workspace-root")) workspace(canonical); else editorroot(canonical);
      roots++;
    }
    if(!roots) die("root required","arguments");
  }
}
int main(int argc, char **argv) {
  defaultCloseOnExec();
  storeOverride=getenv("EDITOR_VIEW_CONTENT_STORE");
  const char *trampoline = getenv("EDITOR_VIEW_LEASE_EXECUTABLE");
  const char *workspaceRoot = getenv("EDITOR_VIEW_LEASE_WORKSPACE_ROOT");
  int command = 0, trampolineMode = trampoline && *trampoline && workspaceRoot && *workspaceRoot;
  const char *inherited=getenv("EDITOR_VIEW_LEASE_FDS");
  if(inherited && *inherited) {
    char *copy=strdup(inherited), *cursor=copy, *token;
    if(!copy) die("allocation failure","inherited fds");
    while((token=strsep(&cursor,","))) {
      char *end; long fd=strtol(token,&end,10);
      if(!*token || *end || fd<3 || fd>INT_MAX || fcntl((int)fd,F_GETFD)<0) die("invalid inherited descriptor",token);
      retain((int)fd);
    }
    free(copy);
  }
  for (int i=1; !trampolineMode && i<argc; i++) {
    if (!strcmp(argv[i],"--")) { command=i+1; break; }
    if ((!strcmp(argv[i],"--content-store") || !strcmp(argv[i],"--workspace-root") || !strcmp(argv[i],"--editor-root")) && i+1<argc) {
      if (!strcmp(argv[i],"--content-store")) storeOverride=argv[i+1];
      if (!strcmp(argv[i],"--workspace-root") && setenv("EDITOR_VIEW_LEASE_WORKSPACE_ROOT",argv[i+1],1)) die("cannot export workspace",argv[i+1]);
      i++;
    } else die("invalid arguments", argv[i]);
  }
  discover(argc,argv,command,trampolineMode,workspaceRoot);
  size_t capacity=count*24+1; char *mapping=calloc(capacity,1); if(!mapping) die("allocation failure","fd mapping");
  size_t used=0;
  for(size_t i=0;i<count;i++) {
    if(fcntl(leases[i].fd,F_SETFD,0)) die("cannot pass lease descriptor","exec");
    used+=(size_t)snprintf(mapping+used,capacity-used,"%s%d",i?",":"",leases[i].fd);
  }
  if(setenv("EDITOR_VIEW_LEASE_FDS",mapping,1)) die("cannot publish descriptor mapping","exec");
  if(setenv("EDITOR_VIEW_LEASE_ACTIVE","1",1)) die("cannot publish active marker","exec");
  if(trampolineMode) { argv[0]=(char *)trampoline; execvp(trampoline,argv); }
  else execvp(argv[command],argv+command);
  die("exec failed",trampolineMode?trampoline:argv[command]);
}
#endif
