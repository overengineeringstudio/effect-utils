source tests/try.sh
printf '%s/.git\n' "$root/linked" > "$admin/gitdir"
hold() {
    "$LEASE" run "$root/linked" --mode "$1" --try --agent agent/test -- sh -c 'echo ready > "$1"; read -r line < "$2"' sh "$root/ready" "$root/release" &
    holder=$!
    read -r ready < "$root/ready"
}
release() {
    printf 'release\n' > "$root/release"
    wait "$holder"
}
wait_open() {
    test -d /proc/self/fd || return 0
    local deadline=$((SECONDS + 3))
    while :; do
        for fd in /proc/"$1"/fd/*; do
            test "$(readlink "$fd" 2>/dev/null)" != "$admin/gate-lease.lock" || return 0
        done
        test "$SECONDS" -lt "$deadline" || return 1
    done
}
for existing in shared exclusive; do
    for requested in shared exclusive; do
        hold "$existing"
        if test "$existing/$requested" = shared/shared; then
            "$LEASE" run "$root/linked" --mode "$requested" --try --agent agent/test --json -- true
        else
            refuse 75 Busy "$LEASE" run "$root/linked" --mode "$requested" --try --agent agent/test --json -- false
            refuse 75 Deadline "$LEASE" run "$root/linked" --mode "$requested" --await 1 --agent agent/test --json -- touch "$root/payload"
            test ! -e "$root/payload"
            "$LEASE" run "$root/linked" --mode "$requested" --await 5 --agent agent/test --json -- sh -c 'exit 23' &
            waiter=$!
            wait_open "$waiter"
            release
            result=0; wait "$waiter" || result=$?
            test "$result" = 23
            continue
        fi
        release
    done
done
hold exclusive
run "$root/main" exclusive true
"$LEASE" run "$root/linked" --mode shared --await 5 --agent agent/test --json -- touch "$root/payload" 2>"$root/error" &
waiter=$!
wait_open "$waiter"
kill -TERM "$waiter"
result=0; wait "$waiter" || result=$?
test "$result" = 143
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["_tag"] == "Cancelled"' "$root/error"
test ! -e "$root/payload"
release

for mutation in registration lock; do
    hold exclusive
    "$LEASE" run "$root/linked" --mode shared --await 5 --agent agent/test --json -- false 2>"$root/error" &
    waiter=$!
    wait_open "$waiter"
    if test "$mutation" = registration; then
        rm "$admin/gitdir"
    else
        mv "$admin/gate-lease.lock" "$admin/old"
        touch "$admin/gate-lease.lock"
    fi
    release
    result=0; wait "$waiter" || result=$?
    test "$result" = 1
    grep -q Retired "$root/error"
    printf '%s/.git\n' "$root/linked" > "$admin/gitdir"
done
python3 tests/group.py "$LEASE" "$root/linked" "$root"
python3 tests/group.py "$LEASE" "$root/linked" "$root" HUP
python3 tests/group.py "$LEASE" "$root/linked" "$root" INT
python3 tests/terminal.py "$LEASE" "$root/linked"
python3 tests/death.py "$LEASE" "$root/linked" "$root"
run "$root/linked" exclusive true
refuse 2 InvalidInput "$LEASE" run --json
refuse 1 AttributionFailure "$LEASE" run "$root/linked" --mode exclusive --try --agent invalid --json -- false
"$LEASE" run "$root/linked" --mode shared --try --agent invalid --job test-job --json -- true 2>"$root/granted"
source tests/schema.sh
cat "$root/granted"
