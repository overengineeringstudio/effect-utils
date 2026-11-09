set -euo pipefail
root=$(mktemp -d "$PWD/../target/lease.XXXXXXXX")
trap 'for child in $(jobs -pr); do kill "$child"; done; rm -r "$root"' EXIT
git init -q "$root/main"
git -C "$root/main" -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=Test -c user.email=test@example.org commit -qm initial --allow-empty
git -C "$root/main" worktree add -qb linked "$root/linked"
admin=$(git -C "$root/linked" rev-parse --absolute-git-dir)
run() { "$LEASE" run "$1" --mode "$2" --try --agent agent/test -- "${@:3}"; }
refuse() {
    local code=$1 tag=$2
    shift 2
    local result=0
    "$@" 2>"$root/error" || result=$?
    test "$result" = "$code"
    grep -q "$tag" "$root/error"
}
ln -s "$root/linked" "$root/alias"
mkdir "$root/linked/sub"
mkfifo "$root/release" "$root/ready"
run "$root/linked" exclusive sh -c 'echo ready > "$1"; read -r line < "$2"' sh "$root/ready" "$root/release" &
holder=$!
read -r ready < "$root/ready"
for path in "$root/alias" "$root/linked/sub"; do
    refuse 75 Busy env GIT_DIR="$root/main/.git" GIT_WORK_TREE="$root/main" GIT_INDEX_FILE=bad GIT_COMMON_DIR=bad GIT_OBJECT_DIRECTORY=bad GIT_ALTERNATE_OBJECT_DIRECTORIES=bad GIT_CONFIG_PARAMETERS=invalid GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.bare GIT_CONFIG_VALUE_0=true GIT_CEILING_DIRECTORIES="$root/linked" "$LEASE" run "$path" --mode shared --try --agent agent/test -- false
done
printf 'release\n' > "$root/release"
wait "$holder"
test "$(stat -c %a "$admin/gate-lease.lock" 2>/dev/null || stat -f %Lp "$admin/gate-lease.lock")" = 600
run "$root/linked" shared sh -c 'for fd in /proc/self/fd/*; do test "$(readlink "$fd")" != "$1" || exit 1; done; exit 23' sh "$admin/gate-lease.lock" && exit 1 || test "$?" = 23
for kind in symlink fifo directory; do
    rm "$admin/gate-lease.lock"
    case "$kind" in
        symlink) ln -s "$root/target" "$admin/gate-lease.lock" ;;
        fifo) mkfifo "$admin/gate-lease.lock" ;;
        directory) mkdir "$admin/gate-lease.lock" ;;
    esac
    refuse 1 UnsafeLock run "$root/linked" shared false
    if test "$kind" = directory; then rmdir "$admin/gate-lease.lock"; else rm "$admin/gate-lease.lock"; fi
    touch "$admin/gate-lease.lock"
done
printf '%s\n' "$root/main/.git" > "$admin/gitdir"
refuse 1 Retired run "$root/linked" shared false
refuse 1 UnknownIdentity run "$root/missing" shared false
