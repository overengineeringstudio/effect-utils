#!/usr/bin/env python3
"""Exercise evidence durability and dead-lettering against a local OTLP/Tempo fixture."""
import concurrent.futures
import hashlib
import http.server
import json
import os
import pathlib
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

binary = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix="buck-evidence-faults-"))
state, upload_sock, resolver_sock = (root / x for x in ("state", "upload.sock", "resolver.sock"))
lock = threading.Lock()
spans = {}
requests = []
down = threading.Event()
block_push = threading.Event()
release_push = threading.Event()


class Tempo(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def reply(self, code, value):
        body = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        assert self.path == "/v1/traces"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with lock:
            requests.append(body)
        if block_push.is_set():
            release_push.wait(timeout=15)
        if down.is_set():
            self.reply(503, {"error": "Tempo unavailable"})
            return
        with lock:
            for rs in body["resourceSpans"]:
                for ss in rs["scopeSpans"]:
                    for span in ss["spans"]:
                        spans.setdefault(span["traceId"], []).append(span["spanId"])
        self.reply(200, {})

    def do_GET(self):
        trace = self.path.rsplit("/", 1)[-1]
        with lock:
            ids = spans.get(trace, [])[:]
        if down.is_set():
            self.reply(503, {})
        elif ids:
            self.reply(200, {"trace": {"resourceSpans": [{"scopeSpans": [{"spans": [{"spanId": sid} for sid in ids]}]}]}})
        else:
            self.reply(404, {})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def eventually(predicate, description, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.05)
    raise AssertionError(f"timed out: {description}; server log:\n{(root / 'server.log').read_text()[-4000:]}")


def command(*args, env=None, check=True):
    proc = subprocess.run([str(binary), *map(str, args)], capture_output=True, text=True,
                          env={**os.environ, **(env or {})})
    if check and proc.returncode:
        raise AssertionError(f"{args}: {proc.stderr}")
    return proc


def digest_of(spool):
    return json.loads((spool / "manifest.json").read_text())["digest"]


def seal(number, poison=False):
    spool = root / f"spool-{number}"
    trace = hashlib.sha256(f"fault-trace-{number}".encode()).hexdigest()[:32]
    if poison:
        (spool / "buck2").mkdir(parents=True)
        (spool / "buck2" / "invalid.pb.zst").write_bytes(b"not a zstd frame")
    else:
        (spool / "spans").mkdir(parents=True)
        span = {"traceId": trace, "spanId": hashlib.sha256(str(number).encode()).hexdigest()[:16],
                "name": "fault run", "startTimeUnixNano": str(time.time_ns() - 10000),
                "endTimeUnixNano": str(time.time_ns())}
        doc = {"resourceSpans": [{"resource": {"attributes": []},
                                  "scopeSpans": [{"scope": {"name": "fault"}, "spans": [span]}]}]}
        (spool / "spans" / "job.jsonl").write_text(json.dumps(doc) + "\n")
    result = command("seal", "--spool", spool, "--run-id", f"ci/test/example%2Frepo/{number}/1",
                     "--task-key", "fault", env={"PIPELINE_REPOSITORY": "example/repo", "VCS_CHANGE_ID": "42"})
    digest = result.stdout.strip().split(":")[-1]
    return spool, digest



def upload(spool):
    result = command("upload", "--spool", spool, "--url", f"unix://{upload_sock}")
    assert "uploaded sha256:" in result.stdout, result.stdout


def record(digest):
    p = subprocess.run(["curl", "--unix-socket", str(resolver_sock), "-sS", "-w", "\n%{http_code}",
                        f"http://localhost/v1/records/{digest}"], capture_output=True, text=True, check=True)
    body, status = p.stdout.rsplit("\n", 1)
    return json.loads(body) if status == "200" else None


def status(digest, expected, timeout=30):
    return eventually(lambda: (r if r and r["status"] == expected else None)
                      if (r := record(digest)) else None, f"{digest} -> {expected}", timeout)


def start():
    for sock in (upload_sock, resolver_sock):
        sock.unlink(missing_ok=True)
    log = open(root / "server.log", "ab", buffering=0)
    proc = subprocess.Popen([str(binary), "serve", "--state-dir", str(state),
                             "--upload-socket", str(upload_sock), "--resolver-socket", str(resolver_sock),
                             "--allow-local-upload", "--sweep-secs", "1", "--workers", "2",
                             "--backoff-cap-secs", "1", "--readback-timeout-secs", "3",
                             "--otlp-endpoint", endpoint, "--tempo-url", endpoint],
                            stdout=log, stderr=log, env={**os.environ, "RUST_LOG": "info"})
    log.close()
    eventually(lambda: resolver_sock.exists() and upload_sock.exists(), "server sockets")
    return proc


fixture = Server(("127.0.0.1", 0), Tempo)
thread = threading.Thread(target=fixture.serve_forever, daemon=True)
thread.start()
endpoint = f"http://127.0.0.1:{fixture.server_port}"
process = start()
try:
    # Duplicate uploads do not create extra queue jobs or pushes.
    spool, digest = seal(1)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(lambda _: upload(spool), range(6)))
    duplicate = status(digest, "ingested")
    assert duplicate["attempts"] == 1, duplicate
    with lock:
        assert len(requests) == 1, len(requests)
    print("duplicate upload: PASS (six concurrent uploads, one push, one attempt)")

    # Malformed native Buck log is permanently dead-lettered, rather than retried.
    spool, digest = seal(2, poison=True)
    upload(spool)
    poisoned = status(digest, "failed")
    assert poisoned["attempts"] == 1 and "zstd" in poisoned["lastError"], poisoned
    print("poison: PASS (failed, one attempt, permanent adapter error)")

    # An unavailable collector must retry, then recover without losing the record.
    down.set()
    spool, digest = seal(3)
    upload(spool)
    eventually(lambda: (r if r and r["attempts"] >= 1 and r["status"] != "failed" else None)
               if (r := record(digest)) else None, "transient collector error")
    down.clear()
    recovered = status(digest, "ingested")
    assert recovered["attempts"] >= 2, recovered
    print(f"Tempo down: PASS (recovered in {recovered['attempts']} attempts)")

    # Kill the server while a push is in flight; the orphaned lease must recover.
    block_push.set()
    spool, digest = seal(4)
    upload(spool)
    eventually(lambda: len(requests) >= 3, "in-flight push")
    process.kill()
    process.wait(timeout=10)
    block_push.clear()
    release_push.set()
    process = start()
    resumed = status(digest, "ingested")
    assert resumed["attempts"] >= 2, resumed
    print("SIGKILL mid-ingest: PASS (orphaned lease recovered)")

    # Burst upload and terminate before every queued record can finish.
    burst = [seal(i) for i in range(10, 20)]
    block_push.set()
    release_push.clear()
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
        list(pool.map(lambda entry: upload(entry[0]), burst))
    eventually(lambda: any((r := record(d)) and r["status"] == "ingesting" for _, d in burst),
               "in-flight burst")
    process.kill()
    process.wait(timeout=10)
    block_push.clear()
    release_push.set()
    process = start()
    for _, digest in burst:
        status(digest, "ingested", timeout=45)
    print("restart during burst: PASS (10/10 ingested)")
finally:
    process.terminate()
    process.wait(timeout=10)
    fixture.shutdown()
    fixture.server_close()
print("server stderr:", root / "server.log")
