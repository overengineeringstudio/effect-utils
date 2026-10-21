#define _POSIX_C_SOURCE 200809L
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <fcntl.h>

/* Intentionally no flock calls: descriptors inherited across real fork + exec
 * must keep ownership even when the original launcher/parent is SIGKILLed. */
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  if (!strcmp(argv[1], "mapped-hold")) {
    const char *mapping=getenv("EDITOR_VIEW_LEASE_FDS");
    if(!mapping || !*mapping || !getenv("EDITOR_VIEW_LEASE_ACTIVE")) return 8;
    char *copy=strdup(mapping), *save=0, *token;
    if(!copy) return 9;
    for(token=strtok_r(copy,",",&save);token;token=strtok_r(0,",",&save)) {
      char *end; long descriptor=strtol(token,&end,10);
      int flags=fcntl((int)descriptor,F_GETFD);
      if(*end || descriptor<3 || flags<0 || (flags&FD_CLOEXEC)) return 10;
    }
    free(copy);
  }
  if (!strcmp(argv[1], "fork")) {
    pid_t child=fork();
    if(child<0) return 3;
    if(child==0) { execl(argv[0],argv[0],"hold",argv[2],(char *)0); _exit(4); }
    for(;;) pause();
  }
  if (!strcmp(argv[1], "hold") || !strcmp(argv[1], "mapped-hold")) {
    int fd=open(argv[2],O_WRONLY|O_CREAT|O_EXCL,0600);
    if(fd<0) return 5;
    if(dprintf(fd,"%ld\n",(long)getpid())<0 || close(fd)) return 6;
    for(;;) pause();
  }
  return 7;
}
