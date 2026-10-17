set -euo pipefail

# A declared script is readable without Bun or any other payload closure.
IFS= read -r first_line < "$1"
[[ "$first_line" == 'set -euo pipefail' ]]

# The repo's real README is deliberately not a declared action input.
if { IFS= read -r _ < README.md; } 2>/dev/null; then
    printf '%s\n' 'undeclared repository read succeeded' >&2
    exit 1
fi
if { IFS= read -r _ < /etc/passwd; } 2>/dev/null; then
    printf '%s\n' 'undeclared host read succeeded' >&2
    exit 1
fi

# Check the namespace has no IPv4 route, then make a real TCP syscall via Bash.
{ IFS= read -r header; ! IFS= read -r route; } < /proc/net/route
if (exec 3<>/dev/tcp/198.51.100.1/9) 2>/dev/null; then
    printf '%s\n' 'external TCP connection succeeded' >&2
    exit 1
fi

printf '%s\n' '{"status":"passed","boundary":"linux-bwrap","tool":"bash","probes":{"declaredInputReadable":true,"undeclaredReadDenied":true,"externalSocketDenied":true}}' > "$2"
