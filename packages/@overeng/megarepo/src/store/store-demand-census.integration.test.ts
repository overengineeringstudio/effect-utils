import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const controllerModule = fileURLToPath(new URL('./store-demand-census.ts', import.meta.url))
const supportsAuthenticatedCensus = process.platform === 'linux' && process.getuid?.() === 0
if (!supportsAuthenticatedCensus)
  console.warn(
    'NOT RUN: authenticated demand census controller integration requires Linux and root for real AF_UNIX peer authentication.',
  )

// Bun runs the production CLOCK_MONOTONIC/SO_PEERCRED boundary. Only the
// filesystem view of /proc is injected, as in store-inuse's lifetime fixtures.
const run = (body: string) => {
  const result = spawnSync(
    process.env.BUN_BIN ?? 'bun',
    [
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { createServer } from 'node:net';
    import { once } from 'node:events';
    import { hostname } from 'node:os';
    import { Effect, Schema, DateTime } from 'effect';
    import * as FileSystem from 'effect/FileSystem';
    import { systemError } from 'effect/PlatformError';
    import { NodeServices } from '@effect/platform-node';
    import { makeDemandCensus } from ${JSON.stringify(controllerModule)};
    import { CensusRequest, CensusResponse } from './store-demand-census-wire.ts';
    import { readCensusMonotonicNs } from './store-demand-census-socket.ts';
    const fs = await Effect.runPromise(Effect.gen(function* () { return yield* FileSystem.FileSystem; }).pipe(Effect.provide(NodeServices.layer)));
    const directory = await Effect.runPromise(fs.makeTempDirectory({ directory: '/run', prefix: 'mr-census-controller-' }));
    await Effect.runPromise(fs.chmod(directory, 0o755));
    const root = directory + '/store';
    await Effect.runPromise(fs.makeDirectory(root));
    const socketPath = directory + '/census.sock';
    let lifetime = '1';
    let readable = false;
    let rawPath = '/outside';
    let statReadable = true;
    let refusal = false;
    let replaceRoot = false;
    let claimsFirst = false;
    let claimClass = 'other';
    let changedBoot;
    let mutateResponse = value => value;
    let changes = [];
    let reads = 0;
    const requests = [];
    const denied = path => Effect.fail(systemError({ _tag:'PermissionDenied', module:'FileSystem', method:'census-fixture', pathOrDescriptor:path }));
    const procFs = {
      ...fs,
      readDirectory: path => path === '/proc' ? Effect.succeed(['424242']) : path.startsWith('/proc/424242/') ? Effect.succeed([]) : fs.readDirectory(path),
      readFileString: (path, ...options) => {
        if (path === '/proc/sys/kernel/random/boot_id' && changedBoot) return Effect.succeed(changedBoot);
        if (path === '/proc/424242/stat') return statReadable ? Effect.succeed('424242 (a) b (c)) S 1 42 42 0 -1 0 ' + '0 '.repeat(12) + lifetime) : denied(path);
        if (path === '/proc/424242/status') return Effect.succeed('Uid: ' + Array(4).fill(process.getuid()).join(' ') + '\\n');
        if (path === '/proc/424242/maps') return Effect.succeed('');
        if (path === '/proc/424242/cmdline') return Effect.succeed('buck2\\0daemon\\0--daemon-id\\0x\\0');
        return fs.readFileString(path, ...options);
      },
      readLink: path => {
        if (path === '/proc/424242/exe') return Effect.succeed('/usr/bin/buck2');
        if (path.startsWith('/proc/424242/')) { reads++; return readable ? Effect.succeed(rawPath) : denied(path); }
        return fs.readLink(path);
      },
    };
    const sockets = new Set();
    const server = createServer({ allowHalfOpen:true }, socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      const chunks = [];
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', async () => {
        try {
          const input = Buffer.concat(chunks);
          assert.equal(input.readUInt32BE(0), input.length - 4);
          const request = Schema.decodeUnknownSync(Schema.fromJsonString(CensusRequest))(new TextDecoder('utf8', {fatal:true}).decode(input.subarray(4)));
          requests.push(request);
          const start = await Effect.runPromise(readCensusMonotonicNs);
          const end = await Effect.runPromise(readCensusMonotonicNs);
          const wall = DateTime.makeUnsafe(new Date());
          const contributed = claimsFirst && requests.length === 1;
          const response = refusal ? { _tag:'Refused', version:1, reason:'busy' } : {
            _tag:'Complete', version:1, bootId:request.bootId, nonce:request.nonce, complete:true,
            captureStartedAt:{monotonicNs:start.toString(),wall}, captureEndedAt:{monotonicNs:end.toString(),wall},
            coverage:request.namedLifetimes.map(identity => ({_tag:'Covered',lifetime:identity,evidence:{_tag:'OwnUidDetails',cwd:contributed?[root]:[],root:[],fdTargets:[],mapTargets:[]}})),
            snapshot:{schemaVersion:'megarepo.workspace-activity.v2',producer:{name:'mr-process',version:'1'},
              epoch:{host:hostname(),snapshotId:request.bootId,storeIndex:0},capturedAt:wall,
              expiresAt:DateTime.makeUnsafe(DateTime.toEpochMillis(wall)+60000),complete:true,errors:[],
              processCoverage:'all-uids',processRoots:[root],processIdentities:request.namedLifetimes,
              claims:contributed?[{workspace:root,sources:['process'],agents:[],activeRuntimeIds:[],active:true,processes:[{...request.namedLifetimes[0],executableClass:claimClass}]}]:[]},
          };
          if (replaceRoot) { await Effect.runPromise(fs.rename(root,root+'-old')); await Effect.runPromise(fs.makeDirectory(root)); }
          lifetime = changes.shift() ?? lifetime;
          const encoded = Schema.encodeSync(Schema.fromJsonString(CensusResponse))(mutateResponse(response));
          const payload = Buffer.from(encoded); const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
          socket.end(Buffer.concat([header,payload]));
        } catch (error) { console.error(error); socket.destroy(); }
      });
    });
    server.listen(socketPath); await once(server,'listening');
    const make = () => Effect.runPromise(makeDemandCensus({fs:procFs,roots:[root],producers:['mr-process'],testOptions:{socketPath}}));
    const probe = (controller,activity,ignoredProcesses,worktreePath=root) => Effect.runPromise(controller.probe({worktreePath,activity,ignoredProcesses}));
    try { ${body} } finally {
      for (const socket of sockets) socket.destroy();
      const closed = Promise.withResolvers(); server.close(closed.resolve); await closed.promise;
      await Effect.runPromise(fs.remove(directory,{recursive:true}));
    }
  `,
    ],
    { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 20_000 },
  )
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr + result.stdout).toBe(0)
}

describe.skipIf(!supportsAuthenticatedCensus)(
  'demand census controller with real authenticated AF_UNIX responder (Linux root)',
  () => {
    it('rescans available references and shares admitted coverage across worktrees', () =>
      run(`
    const controller = await make();
    const first = await probe(controller);
    assert.equal(first.holder._tag,'free'); assert.equal(requests.length,1);
    const readAfterCapture = reads;
    const other=root+'/other'; await Effect.runPromise(fs.makeDirectory(other));
    const second = await probe(controller,undefined,undefined,other);
    assert.equal(second.holder._tag,'free'); assert.equal(requests.length,1); assert.ok(reads>readAfterCapture);
    readable=true; rawPath=root+'/new-holder';
    const fresh = await probe(controller);
    assert.equal(fresh.holder._tag,'in-use'); assert.equal(fresh.holder.holder.path,rawPath); assert.equal(requests.length,1);
  `))

    it('requests only new lifetimes, replaces identity grants, and bounds run-wide churn', () =>
      run(`
    changes=['2','3','4']; const controller=await make();
    const result=await probe(controller);
    assert.equal(result.holder._tag,'unknown'); assert.match(result.failure.details,/attempt limit/);
    assert.deepEqual(requests.map(request=>request.namedLifetimes[0].startTime),['1','2','3']);
    assert.deepEqual(result.activity.processCoverage.processIdentities,[{pid:424242,startTime:'3'}]);
    assert.equal(new Set(requests.map(request=>request.nonce)).size,3);
    lifetime='5'; await probe(controller); assert.equal(requests.length,3);
  `))

    it('retains conservative observed claims while replacing identities', () =>
      run(`
    claimsFirst=true; changes=['2']; const controller=await make();
    const result=await probe(controller);
    assert.equal(result.holder._tag,'free'); assert.equal(requests.length,2);
    assert.ok(result.activity.processClaimPaths.has(root));
    assert.ok(result.activity.processPaths.has(root));
    assert.deepEqual(result.activity.processCoverage.processIdentities,[{pid:424242,startTime:'2'}]);
  `))

    it('never retries a refusal for a later unknown lifetime and retains failed probe details', () =>
      run(`
    refusal=true; const controller=await make(); const first=await probe(controller);
    assert.equal(first.holder._tag,'unknown'); assert.equal(first.holder.pid,424242); assert.ok(first.holder.probe.path.startsWith('/proc/424242/'));
    assert.equal(first.failure.refusalReason,'busy'); lifetime='2'; await probe(controller); assert.equal(requests.length,1);
  `))

    it('does not request when field 22 is unavailable', () =>
      run(`
    statReadable=false; const controller=await make(); const result=await probe(controller);
    assert.equal(result.holder._tag,'unknown'); assert.equal(requests.length,0);
  `))

    it('vetoes canonical-root inode replacement during capture', () =>
      run(`
    replaceRoot=true; const controller=await make(); const result=await probe(controller);
    assert.equal(result.holder._tag,'unknown'); assert.match(result.failure.details,/root identity changed/);
  `))

    it('preserves native seat/PTY activity and exact ignored-daemon lifetime semantics', () =>
      run(`
    const controller=await make();
    const activity={activePaths:new Set(['/native-seat']),ownerClaims:[{workspace:'/native-seat',agents:['owner']}],epoch:{host:hostname(),producer:'native',snapshotId:'native',storeIndex:1}};
    const result=await probe(controller,activity);
    assert.equal(result.holder._tag,'free'); assert.ok(result.activity.activePaths.has('/native-seat'));
    assert.deepEqual(result.activity.ownerClaims,activity.ownerClaims); assert.deepEqual(result.activity.epoch,activity.epoch);
    readable=true; rawPath=root+'/buck';
    assert.equal((await probe(controller,activity,[{pid:424242,startTime:'1'}])).holder._tag,'free');
    assert.equal((await probe(controller,activity,[{pid:424242,startTime:'0'}])).holder._tag,'in-use');
  `))
    it('keeps known holders without requesting a census', () =>
      run(`
    readable=true; rawPath=root+'/holder'; const result=await probe(await make());
    assert.equal(result.holder._tag,'in-use'); assert.equal(requests.length,0);
  `))

    it('re-evaluates ignored daemon claims rather than permanently dropping observed holders', () =>
      run(`
    claimsFirst=true; claimClass='buck2-daemon'; const controller=await make();
    const ignored=[{pid:424242,startTime:'1'}];
    const first=await probe(controller,undefined,ignored);
    assert.equal(first.holder._tag,'free'); assert.equal(first.activity.processClaimPaths.size,0);
    assert.equal(first.activity.processPaths.size,0);
    const restored=await probe(controller,undefined,[{pid:424242,startTime:'0'}]);
    assert.ok(restored.activity.processClaimPaths.has(root)); assert.equal(requests.length,1);
    assert.ok(restored.activity.processPaths.has(root));
  `))

    it.each([
      ['foreign host', `value.snapshot.epoch.host='another-host'`],
      [
        'expired manifest',
        `value.snapshot.expiresAt=DateTime.makeUnsafe(DateTime.toEpochMillis(value.snapshot.capturedAt)-1)`,
      ],
      [
        'excess TTL',
        `value.snapshot.expiresAt=DateTime.makeUnsafe(DateTime.toEpochMillis(value.snapshot.capturedAt)+300001)`,
      ],
      ['local boot change', `changedBoot='00000000-0000-0000-0000-000000000002'`],
    ])('vetoes shared v2 admission failure: %s', (_name, mutation) =>
      run(`
    mutateResponse=value=>{${mutation};return value}; const result=await probe(await make());
    assert.equal(result.holder._tag,'unknown'); assert.ok(result.failure); assert.equal(requests.length,1);
  `),
    )
  },
)
