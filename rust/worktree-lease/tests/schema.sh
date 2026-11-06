"$LEASE" inspect "$root/main" --json > "$root/absent"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); assert r["_tag"] == "Inspected" and r["record"] is None' "$root/absent"
"$LEASE" create "$root/linked" --purpose gate --creator agent/first --ttl 30 >"$root/first" 2>"$root/first-error" &
first=$!
"$LEASE" create "$root/linked" --purpose gate --creator agent/second --ttl 30 >"$root/second" 2>"$root/second-error" &
second=$!
one=0; wait "$first" || one=$?
two=0; wait "$second" || two=$?
test "$one:$two" = 0:2 || test "$one:$two" = 2:0
winner="$root/first"; if test "$two" = 0; then winner="$root/second"; fi
"$LEASE" inspect "$root/alias/sub" --json > "$root/created"
python3 -c 'import json,sys; a,b=(json.load(open(p)) for p in sys.argv[1:3]); assert a["_tag"] == "Created" and b["_tag"] == "Inspected"; assert a["record"] == b["record"]; assert b["record"]["holder"]["pid"] == int(sys.argv[3])' "$winner" "$root/created" "$$"
python3 -c 'import json,os,sys; h=json.load(open(sys.argv[1]))["record"]["holder"]; s=os.stat("/proc/self/ns/pid") if sys.platform == "linux" else None; assert s is None or h["pidNamespace"] == {"dev":s.st_dev,"ino":s.st_ino}' "$root/created"
refuse 2 InvalidInput "$LEASE" create "$root/linked" --purpose gate --creator agent/duplicate --ttl 30
refuse 2 InvalidInput "$LEASE" create "$root/main" --purpose invalid --creator agent/test --ttl 30
refuse 2 InvalidInput "$LEASE" create "$root/main" --purpose gate --creator invalid --ttl 30
refuse 2 InvalidInput "$LEASE" create "$root/main" --purpose gate --creator agent/test --ttl 0
"$LEASE" renew "$root/linked" --holder-pid "$$" --agent agent/renewed --ttl 60 >"$root/renewed"
python3 -c 'import json,sys; a,b=(json.load(open(p)) for p in sys.argv[1:]); assert b["_tag"] == "Renewed"; a,b=a["record"],b["record"]; assert all(a[k] == b[k] for k in ("creatorSeat","purpose","createdAt")); assert b["holder"]["agent"] == "agent/renewed"; assert b["expiresAt"] > a["expiresAt"]' "$root/created" "$root/renewed"
"$LEASE" renew "$root/linked" --holder-pid "$$" --agent agent/long --ttl 600 >"$root/long" &
long=$!
"$LEASE" renew "$root/linked" --holder-pid "$$" --agent agent/short --ttl 1 >"$root/short" &
short=$!
wait "$long"; wait "$short"
"$LEASE" renew "$root/linked" --holder-pid "$$" --agent agent/short --ttl 1 >"$root/final"
python3 -c 'import json,sys; a,b,c=(json.load(open(p))["record"] for p in sys.argv[1:]); assert c["expiresAt"] >= max(a["expiresAt"],b["expiresAt"])' "$root/long" "$root/short" "$root/final"
hold exclusive
refuse 75 Busy "$LEASE" create "$root/linked" --purpose gate --creator agent/test --ttl 30
refuse 75 Busy "$LEASE" renew "$root/linked" --holder-pid "$$" --agent agent/renewed --ttl 60
release
refuse 1 Protected "$LEASE" guard --git-dir "$admin"
refuse 1 UnknownIdentity "$LEASE" guard --git-dir "$root"
rm "$admin/gate-lease.json"
hold shared
refuse 1 Protected "$LEASE" guard --git-dir "$admin"
release
"$LEASE" guard --git-dir "$admin" > "$root/eligible"
"$LEASE" guard --git-dir "$root/main/.git" > "$root/eligible"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["_tag"] == "Eligible"' "$root/eligible"
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
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["record"]["holder"]["pid"] == int(sys.argv[2])' "$root/explicit" "$$"
if test "$(id -u)" != 0; then
    cp "$root/explicit" "$admin/gate-lease.json"
    python3 -c 'import os,sys; os.chmod(sys.argv[1],0)' "$admin/gate-lease.json"
    refuse 1 UnsafeLock "$LEASE" inspect "$root/linked" --json
    python3 -c 'import os,sys; os.chmod(sys.argv[1],0o600)' "$admin/gate-lease.json"
fi
