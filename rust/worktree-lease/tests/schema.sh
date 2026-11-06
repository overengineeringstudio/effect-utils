"$LEASE" inspect "$root/main" --json > "$root/absent"
test "$(cat "$root/absent")" = null
"$LEASE" create "$root/linked" --purpose gate --creator agent/first --ttl 30 >"$root/first" 2>"$root/first-error" &
first=$!
"$LEASE" create "$root/linked" --purpose gate --creator agent/second --ttl 30 >"$root/second" 2>"$root/second-error" &
second=$!
one=0; wait "$first" || one=$?
two=0; wait "$second" || two=$?
test "$one:$two" = 0:2 || test "$one:$two" = 2:0
winner="$root/first"; if test "$two" = 0; then winner="$root/second"; fi
"$LEASE" inspect "$root/alias/sub" --json > "$root/created"
cmp "$winner" "$root/created"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["holder"]["pid"] == int(sys.argv[2]); assert r["schema"] == 1' "$root/created" "$$"
refuse 2 InvalidInput "$LEASE" create "$root/linked" --purpose gate --creator agent/duplicate --ttl 30
refuse 2 InvalidInput "$LEASE" create "$root/main" --purpose invalid --creator agent/test --ttl 30
refuse 2 InvalidInput "$LEASE" create "$root/main" --purpose gate --creator invalid --ttl 30
refuse 2 InvalidInput "$LEASE" create "$root/main" --purpose gate --creator agent/test --ttl 0
"$LEASE" renew "$root/linked" --holder-pid "$$" --agent agent/renewed --ttl 60 >"$root/renewed"
python3 -c 'import json,sys; a,b=(json.load(open(p)) for p in sys.argv[1:]); assert all(a[k] == b[k] for k in ("creatorSeat","purpose","createdAt")); assert b["holder"]["agent"] == "agent/renewed"; assert b["expiresAt"] > a["expiresAt"]' "$root/created" "$root/renewed"
hold exclusive
refuse 75 Busy "$LEASE" renew "$root/linked" --holder-pid "$$" --agent agent/renewed --ttl 60
release
refuse 1 Protected "$LEASE" guard --git-dir "$admin"
refuse 1 UnknownIdentity "$LEASE" guard --git-dir "$root"
rm "$admin/gate-lease.json"
hold shared
refuse 1 Protected "$LEASE" guard --git-dir "$admin"
release
"$LEASE" guard --git-dir "$admin"
"$LEASE" guard --git-dir "$root/main/.git"
ln -s "$root/created" "$admin/gate-lease.json"
refuse 1 UnsafeLock "$LEASE" inspect "$root/linked" --json
rm "$admin/gate-lease.json"
mkfifo "$admin/gate-lease.json"
refuse 1 UnsafeLock "$LEASE" guard --git-dir "$admin"
rm "$admin/gate-lease.json"
mkdir "$admin/gate-lease.json"
refuse 1 UnsafeLock "$LEASE" inspect "$root/linked" --json
rmdir "$admin/gate-lease.json"
python3 -c 'import subprocess,sys; subprocess.run([sys.argv[1],"create",sys.argv[2],"--purpose","lander","--creator","agent/explicit","--holder-pid",sys.argv[3],"--ttl","30"],check=True)' "$LEASE" "$root/main" "$$" >"$root/explicit"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["holder"]["pid"] == int(sys.argv[2])' "$root/explicit" "$$"
if test "$(id -u)" != 0; then
    cp "$root/explicit" "$admin/gate-lease.json"
    python3 -c 'import os,sys; os.chmod(sys.argv[1],0)' "$admin/gate-lease.json"
    refuse 1 UnsafeLock "$LEASE" inspect "$root/linked" --json
    python3 -c 'import os,sys; os.chmod(sys.argv[1],0o600)' "$admin/gate-lease.json"
fi
