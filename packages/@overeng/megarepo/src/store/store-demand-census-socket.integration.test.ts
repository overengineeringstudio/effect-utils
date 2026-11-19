import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const transport = fileURLToPath(new URL('./store-demand-census-socket.ts', import.meta.url))
const unavailableReason =
  process.platform !== 'linux'
    ? 'requires Linux AF_UNIX, SO_PEERCRED, and CLOCK_MONOTONIC'
    : process.getuid?.() !== 0
      ? 'requires root to create authenticated endpoints and exercise UID boundaries'
      : undefined
if (unavailableReason !== undefined) {
  console.warn(`NOT RUN: demand census socket integration suite: ${unavailableReason}`)
}

// FFI runs in the actual Bun runtime, not a Vitest mock of the native boundary.
// Root-only cases create disposable endpoints under /run: /tmp is deliberately
// not an acceptable authenticated directory chain, even for a test override.
const run = (body: string) => {
  const result = spawnSync(
    process.env.BUN_BIN ?? 'bun',
    [
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:net';
    import { mkdtempSync, chmodSync, chownSync, symlinkSync, rmSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { Effect, Schema } from 'effect';
    import { CensusRequest } from './store-demand-census-wire.ts';
    import { requestCensus, readCensusMonotonicNs } from ${JSON.stringify(transport)};
    const directory = mkdtempSync('/run/mr-census-test-');
    chmodSync(directory, 0o755);
    const path = directory + '/census.sock';
    const request = Schema.decodeUnknownSync(CensusRequest)({
      version: 1, bootId: '12345678-1234-1234-1234-123456789abc', nonce: 'a'.repeat(64),
      requestedAt: { monotonicNs: '1', wall: '2026-11-18T00:00:00Z' },
      requesterUid: process.getuid(), authorizedRoots: ['/store'], namedLifetimes: [{pid: 42, startTime: '1'}],
    });
    const frame = (value) => {
      const body = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
      const header = Buffer.alloc(4); header.writeUInt32BE(body.length); return Buffer.concat([header, body]);
    };
    const refused = { _tag: 'Refused', version: 1, reason: 'busy' };
    const rpc = (duration = 2000000000n, socketPath = path) => Effect.gen(function* () {
      const now = yield* readCensusMonotonicNs;
      return yield* requestCensus({ request, deadlineNs: now + duration, socketPath });
    });
    const failure = async (effect, reason) => {
      const result = await Effect.runPromise(Effect.result(effect));
      assert.equal(result._tag, 'Failure'); assert.equal(result.failure.reason, reason);
    };
    const sockets = new Set();
    let server;
    const listen = async (respond) => {
      server = createServer({ allowHalfOpen: true }, socket => {
        sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
        const chunks = []; socket.on('data', chunk => chunks.push(chunk));
        socket.on('end', () => {
          const input = Buffer.concat(chunks);
          assert.equal(input.readUInt32BE(0), input.length - 4);
          const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(input.subarray(4)));
          assert.equal(value.nonce, request.nonce);
          respond(socket);
        });
      });
      server.listen(path); await once(server, 'listening');
    };
    try { ${body} } finally {
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise(resolve => server.close(resolve));
      rmSync(directory, {recursive: true, force: true});
    }
  `,
    ],
    { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 15_000 },
  )
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr + result.stdout).toBe(0)
}

describe.skipIf(unavailableReason !== undefined)(
  'authenticated demand census AF_UNIX transport (Linux root)',
  () => {
    it('accepts an authenticated valid complete frame and CLOCK_MONOTONIC stamp', () =>
      run(`
    await listen(socket => socket.end(frame({
      _tag: 'Complete', version: 1, bootId: request.bootId, nonce: request.nonce,
      captureStartedAt: { monotonicNs: '2', wall: '2026-11-18T00:00:00Z' },
      captureEndedAt: { monotonicNs: '3', wall: '2026-11-18T00:00:00Z' }, complete: true,
      coverage: [{_tag: 'Exited', lifetime: request.namedLifetimes[0]}],
      snapshot: {schemaVersion:'megarepo.workspace-activity.v2', producer:{name:'mr-process',version:'1'},
        epoch:{host:'localhost',snapshotId:request.bootId,storeIndex:0}, capturedAt:'2026-11-18T00:00:00Z',
        expiresAt:'2026-11-18T00:01:00Z',complete:true,errors:[],claims:[],processCoverage:'all-uids',
        processRoots:['/store'],processIdentities:[]},
    })));
    const before = await Effect.runPromise(readCensusMonotonicNs);
    const result = await Effect.runPromise(rpc());
    assert.equal(result.response._tag, 'Complete'); assert.ok(BigInt(result.receivedAt.monotonicNs) >= before);
  `))

    it('returns a valid refusal without treating it as complete evidence', () =>
      run(`
    await listen(socket => socket.end(frame(refused)));
    assert.equal((await Effect.runPromise(rpc())).response._tag, 'Refused');
  `))

    it('allows an unprivileged client to authenticate a root responder without ptrace access', () =>
      run(`
    await listen(socket => socket.end(frame(refused))); chmodSync(path,0o666);
    const encoded = Schema.encodeSync(Schema.fromJsonString(CensusRequest))({...request,requesterUid:65534});
    const clientSource = "import {Effect,Schema} from 'effect'; import {CensusRequest} from './store-demand-census-wire.ts'; import {requestCensus,readCensusMonotonicNs} from "
      + JSON.stringify(${JSON.stringify(transport)}) + "; const request=Schema.decodeUnknownSync(CensusRequest)(" + encoded
      + "); const now=await Effect.runPromise(readCensusMonotonicNs); const result=await Effect.runPromise(requestCensus({request,deadlineNs:now+2000000000n,socketPath:"
      + JSON.stringify(path) + "})); if(result.response._tag!=='Refused') process.exit(1);";
    const child = spawn(process.execPath,['--eval',clientSource],{uid:65534,gid:65534,stdio:['ignore','pipe','pipe']});
    let errors = ''; child.stderr.on('data',chunk => { errors += chunk; });
    const [status] = await once(child,'exit'); assert.equal(status,0,errors);
  `))

    it('accepts a frame split across header and body reads', () =>
      run(`
    await listen(socket => {
      const bytes = frame(refused); socket.write(bytes.subarray(0,2));
      setImmediate(() => { socket.write(bytes.subarray(2,7)); setImmediate(() => socket.end(bytes.subarray(7))); });
    });
    assert.equal((await Effect.runPromise(rpc())).response._tag, 'Refused');
  `))

    it('rejects an oversized encoded request before connecting', () =>
      run(`
    const now = await Effect.runPromise(readCensusMonotonicNs);
    await failure(requestCensus({request:{...request,authorizedRoots:['/'+ 'a'.repeat(65536)]},deadlineNs:now+2000000000n,socketPath:path}), 'request');
  `))

    it.each([
      [
        'oversize',
        `const header = Buffer.alloc(4); header.writeUInt32BE(4 * 1024 * 1024 + 1); socket.end(header);`,
        'framing',
      ],
      ['short header', `socket.end(Buffer.from([0,0]));`, 'framing'],
      ['short body', `socket.end(frame(refused).subarray(0, 8));`, 'framing'],
      ['extra byte', `socket.end(Buffer.concat([frame(refused), Buffer.from([0])]));`, 'framing'],
      ['second frame', `socket.end(Buffer.concat([frame(refused), frame(refused)]));`, 'framing'],
      ['invalid UTF8', `socket.end(Buffer.from([0,0,0,1,255]));`, 'response'],
      ['invalid JSON', `socket.end(frame('{'));`, 'response'],
      [
        'schema mismatch',
        `socket.end(frame({_tag:'Refused',version:2,reason:'busy'}));`,
        'response',
      ],
      ['extra schema fields', `socket.end(frame({...refused, rawPath:'/private'}));`, 'response'],
    ])('rejects %s', (_name, responder, reason) =>
      run(`
    await listen(socket => { ${responder} }); await failure(rpc(), ${JSON.stringify(reason)});
  `),
    )

    it('rejects a delayed extra byte, even after receiving a complete frame', () =>
      run(`
    await listen(socket => { socket.write(frame(refused)); setImmediate(() => socket.end(Buffer.from([0]))); });
    await failure(rpc(), 'framing');
  `))

    it('requires EOF and clips its timeout to the caller deadline', () =>
      run(`
    await listen(socket => socket.write(frame(refused)));
    await failure(rpc(100000000n), 'deadline');
  `))

    it('rejects an already expired deadline', () => run(`await failure(rpc(0n), 'deadline');`))

    it('rejects a root-owned stale socket with no listener', () =>
      run(`
    await listen(socket => socket.end()); await new Promise(resolve => server.close(resolve)); server = undefined;
    // server.close unlinks its path: bind a stale filesystem socket via libc instead.
    const {dlopen} = await import('bun:ffi');
    const lib = dlopen('libc.so.6', {socket:{args:['i32','i32','i32'],returns:'i32'}, bind:{args:['i32','ptr','u32'],returns:'i32'}, close:{args:['i32'],returns:'i32'}}).symbols;
    const fd = lib.socket(1,1,0); const bytes = Buffer.from(path+'\\0'); const address = Buffer.alloc(2+bytes.length); address.writeUInt16LE(1); bytes.copy(address,2);
    assert.equal(lib.bind(fd,address,address.length),0); lib.close(fd);
    await failure(rpc(), 'connection');
  `))

    it('rejects wrong socket ownership', () =>
      run(`
    await listen(socket => socket.end(frame(refused))); chownSync(path,65534,65534);
    await failure(rpc(), 'authentication');
  `))

    it('rejects a writable parent directory and symlink endpoint', () =>
      run(`
    await listen(socket => socket.end(frame(refused))); chmodSync(directory,0o777);
    await failure(rpc(), 'authentication'); chmodSync(directory,0o755);
    symlinkSync(path,directory+'/alias.sock'); await failure(rpc(2000000000n,directory+'/alias.sock'), 'authentication');
  `))

    it('rejects a nonroot peer even when its socket and directory are root-owned', () =>
      run(`
    chownSync(directory,65534,65534);
    const source = "const {createServer}=require('node:net'); const server=createServer(s=>s.end()); server.listen(process.argv[1],()=>process.stdout.write('ready\\\\n'));";
    const child = spawn(process.execPath,['--eval',source,path],{uid:65534,gid:65534,stdio:['ignore','pipe','pipe']});
    try {
      await once(child.stdout,'data'); chownSync(directory,0,0); chownSync(path,0,0);
      await failure(rpc(), 'authentication');
    } finally { child.kill(); await once(child,'exit'); }
  `))
  },
)
