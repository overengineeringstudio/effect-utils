import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}
const bun = requireTool('BUN_BIN')
const launcher = requireTool('EDITOR_VIEW_LEASE_BIN')
const childHelper = requireTool('EDITOR_VIEW_LEASE_TEST_CHILD_BIN')
const leaseModule = fileURLToPath(new URL('./editor-view-leases.ts', import.meta.url))
const sharingModule = fileURLToPath(new URL('./editor-view-sharing.ts', import.meta.url))
const readersModule = fileURLToPath(new URL('./editor-view-readers.ts', import.meta.url))

// Bun is the actual FFI runtime. Vitest itself need not import bun:ffi.
const run = (body: string): void => {
  const source = `
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs';
    import { isAbsolute, join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { spawn, spawnSync } from 'node:child_process';
    import { once } from 'node:events';
    import { setTimeout as delay } from 'node:timers/promises';
    import { acquireEditorViewLease, ensureEditorViewLeaseControl, probeEditorViewLease, probeEditorViewLeaseUnderFence, observeEditorViewLeaseForRetirement, editorViewLeaseFilesystem } from ${JSON.stringify(leaseModule)};
    import { withEditorViewContentStoreLock } from ${JSON.stringify(sharingModule)};
    const launcher = ${JSON.stringify(launcher)};
    const helper = ${JSON.stringify(childHelper)};
    const root = fs.realpathSync(fs.mkdtempSync(join(process.platform === 'linux' ? '/dev/shm' : tmpdir(), 'editor-leases-')));
    const editorRoot = join(root, '.editor-view');
    const contentStore = join(root, 'cas', 'v1');
    fs.mkdirSync(contentStore, { recursive: true });
    const snapshot = 'default-abc';
    const payload = join(editorRoot, '.store', snapshot);
    fs.mkdirSync(payload, { recursive: true });
    const input = { editorRoot, snapshot };
    const control = join(editorRoot, '.leases', snapshot + '.lock');
    const fence = (run) => withEditorViewContentStoreLock({ contentStore, run });
    const acquire = (resolveSnapshot = () => snapshot) => acquireEditorViewLease({ editorRoot, contentStore, resolveSnapshot });
    const probe = () => { const result = probeEditorViewLease(input); result.release(); return result.state; };
    const waitUntil = async (predicate) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) { if (Date.now() > deadline) throw new Error('condition deadline'); await delay(5); }
    };
    const launched = [];
    const launch = (mode, ready) => {
      const child = spawn(launcher, ['--content-store', contentStore, '--editor-root', editorRoot, '--', helper, mode, ready], {
        env: { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' }, stdio: 'ignore'
      });
      launched.push(child); return child;
    };
    try {
      assert.equal(editorViewLeaseFilesystem(root), 'local');
      await fence(async () => ensureEditorViewLeaseControl(input));
      fs.symlinkSync('.store/' + snapshot, join(editorRoot, 'default'));
      ${body}
    } finally {
      for (const child of launched) child.kill('SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
    }
  `
  const result = spawnSync(bun, ['--eval', source], { encoding: 'utf8', timeout: 30_000 })
  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}

describe('editor generation native leases (Linux and macOS)', () => {
  it('lease implementations release only by closing, never by explicit unlock', () =>
    run(`
      for (const source of [
        ${JSON.stringify(fileURLToPath(new URL('../native/editor-view-lease.c', import.meta.url)))},
        ${JSON.stringify(fileURLToPath(new URL('../../../../nix/editor-view-lease/inherit.cjs', import.meta.url)))},
        ${JSON.stringify(leaseModule)},
      ]) {
        const text = fs.readFileSync(source, 'utf8');
        assert.doesNotMatch(text, /\\bflock\\s*\\([^;]*\\bLOCK_UN\\b/);
        assert.doesNotMatch(text, /\\bflock\\s*\\([^,]+,\\s*8\\s*\\)/);
      }
    `))

  it.each(['leased', 'unleased'])(
    'a real %s payload reader keeps its generation held without misclassifying siblings',
    (mode) =>
      run(`
      const { classifyEditorViewProcessCandidates, editorViewAutomaticEvictionEvidence } = await import(${JSON.stringify(readersModule)});
      const second = 'default-def';
      const sibling = join(editorRoot, '.store', second);
      fs.mkdirSync(sibling);
      const file = join(payload, 'payload');
      fs.writeFileSync(file, 'reader payload');
      const ready = join(root, 'payload-reader-ready');
      const program = [
        "const fs = require('node:fs');",
        "const fd = fs.openSync(process.env.READER_PAYLOAD, 'r');",
        "fs.writeFileSync(process.env.READER_READY, String(fd));",
        "process.stdin.resume(); process.stdin.on('data', () => fs.fstatSync(fd));",
      ].join('\\n');
      const command = [${JSON.stringify(bun)}, '--eval', program];
      const child = spawn(${JSON.stringify(mode)} === 'leased' ? launcher : command[0],
        ${JSON.stringify(mode)} === 'leased'
          ? ['--content-store', contentStore, '--editor-root', editorRoot, '--', ...command]
          : command.slice(1), {
        env: { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '', READER_PAYLOAD: file, READER_READY: ready },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      launched.push(child);
      await waitUntil(() => fs.existsSync(ready));
      const candidates = [
        { key: 'A', editorRoot, snapshotRoot: payload, linkedInodes: [] },
        { key: 'B', editorRoot, snapshotRoot: sibling, linkedInodes: [] },
      ];
      const observed = classifyEditorViewProcessCandidates({ candidates, processIds: [process.pid, child.pid] });
      assert.equal(observed.get('A').state, 'held');
      assert.equal(observed.get('A').unmanaged, ${JSON.stringify(mode)} !== 'leased');
      assert.equal(observed.get('B').state, 'clear');
      const policy = editorViewAutomaticEvictionEvidence({ editorRoot, candidates, evidence: observed });
      assert.equal(policy.state, ${JSON.stringify(mode)} === 'leased' ? 'clear' : 'held');
      // B remains lease-evictable only in the leased-reader case. Legacy policy
      // forbids retiring any sibling when this actual holder has no lease.
      await fence(async () => {
        const probe = probeEditorViewLeaseUnderFence({ editorRoot, snapshot: second });
        try { assert.equal(probe.state, 'clear'); } finally { probe.release(); }
      });
    `),
  )

  it('a FIFO control without a writer is rejected without blocking', () =>
    run(`
      const { editorViewProcessLease, readEditorViewPinRecord } = await import(${JSON.stringify(readersModule)});
      fs.unlinkSync(control);
      const { dlopen } = await import('bun:ffi');
      const libc = dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
        mkfifo: { args: ['ptr', 'u32'], returns: 'i32' },
      });
      try { assert.equal(libc.symbols.mkfifo(Buffer.from(control + '\\0'), 0o600), 0); }
      finally { libc.close(); }
      assert.equal(editorViewProcessLease.probe({ pid: String(process.pid), fd: '0', control }), false);
      assert.equal(probe(), 'unknown');
      assert.throws(() => readEditorViewPinRecord({ path: control, name: 'fifo' }), /regular file/);
    `))

  it('an unlocked control fd is not a lease even while another description holds SH', () =>
    run(`
      const { editorViewProcessLease } = await import(${JSON.stringify(readersModule)});
      const lease = await acquire();
      const unrelated = fs.openSync(control, 'r');
      try {
        assert.equal(probe(), 'held');
        assert.equal(editorViewProcessLease.probe({ pid: String(process.pid), fd: String(unrelated), control }), false);
        assert.equal(editorViewProcessLease.probe({ pid: String(process.pid), fd: '2147483647', control }), false);
      } finally { fs.closeSync(unrelated); lease.release(); }
    `))

  it('the host-wide scan never authorizes automatic eviction with unknown reader evidence', () =>
    run(`
      const { classifyEditorViewProcessCandidates, editorViewAutomaticEvictionEvidence } = await import(${JSON.stringify(readersModule)});
      const candidates = [{ key: 'A', editorRoot, snapshotRoot: payload, linkedInodes: [] }];
      const evidence = classifyEditorViewProcessCandidates({ candidates });
      const unknown = [...evidence.values()].some(value => value.state === 'unknown' || value.scanComplete === false);
      const policy = editorViewAutomaticEvictionEvidence({ editorRoot, candidates, evidence });
      assert.equal(unknown && policy.state === 'clear', false);
    `))

  it('concurrent SH excludes EX; closing one inherited description never unlocks another', () =>
    run(`
    const left = await acquire(); const right = await acquire();
    assert.equal(probe(), 'held');
    const observedHeld = observeEditorViewLeaseForRetirement(input);
    assert.equal(observedHeld.kind, 'held'); assert.equal(observedHeld.state, 'held'); observedHeld.release();
    left.release(); left.release(); assert.equal(probe(), 'held');
    right.release(); assert.equal(probe(), 'clear');
    const observedClear = observeEditorViewLeaseForRetirement(input);
    assert.equal(observedClear.kind, 'clear'); assert.equal(observedClear.state, 'clear');
    assert.equal(probe(), 'held'); observedClear.release();
    const exclusive = probeEditorViewLease(input); assert.equal(exclusive.state, 'clear');
    await assert.rejects(acquire()); exclusive.release();
    const reader = await acquire(); reader.release();
  `))

  it('resolves the pointer only after admission to the CAS fence', () =>
    run(`
    const second = 'default-def'; fs.mkdirSync(join(editorRoot, '.store', second));
    const { promise: admitted, resolve: entered } = Promise.withResolvers();
    const { promise: released, resolve: releaseFence } = Promise.withResolvers();
    const held = fence(async () => {
      ensureEditorViewLeaseControl({ editorRoot, snapshot: second }); entered();
      await released;
      fs.unlinkSync(join(editorRoot, 'default')); fs.symlinkSync('.store/' + second, join(editorRoot, 'default'));
    });
    await admitted;
    let resolved = false;
    const pending = acquire(() => { resolved = true; return fs.realpathSync(join(editorRoot, 'default')); });
    await delay(20); assert.equal(resolved, false);
    releaseFence(); await held;
    const lease = await pending; assert.equal(lease.generation, second); lease.release();
  `))

  it('persistent control survives generation retirement and recreation without split-inode locks', () =>
    run(`
    const reader = await acquire(); const inode = fs.lstatSync(control).ino;
    fs.rmSync(payload, { recursive: true }); fs.mkdirSync(payload);
    await fence(async () => ensureEditorViewLeaseControl(input));
    assert.equal(fs.lstatSync(control).ino, inode); assert.equal(probe(), 'held');
    reader.release(); assert.equal(probe(), 'clear');
  `))

  it.each(['retire', 'admit'])(
    'lazy fenced control admission serializes a concurrent reader: %s',
    (outcome) =>
      run(`
    const outcome = ${JSON.stringify(outcome)};
    fs.rmSync(join(editorRoot, '.leases'), { recursive: true });
    fs.writeFileSync(join(payload, 'reader-source'), 'safe');
    const observation = observeEditorViewLeaseForRetirement(input);
    assert.equal(observation.state, 'clear'); assert.equal(observation.kind, 'no-control');
    assert.match(observation.reasons.join(';'), /clear under fence/); observation.release();
    assert.equal(fs.existsSync(control), false); assert.equal(probe(), 'unknown');
    const started = join(root, 'waiting-reader'); const resolved = join(root, 'reader-resolved');
    const result = join(root, 'reader-result');
    let child;
    await fence(async () => {
      const source = [
        'import * as fs from "node:fs";',
        'import { acquireEditorViewLease } from ' + JSON.stringify(${JSON.stringify(leaseModule)}) + ';',
        'fs.writeFileSync(' + JSON.stringify(started) + ', "started");',
        'try {',
        ' const lease = await acquireEditorViewLease({ editorRoot: ' + JSON.stringify(editorRoot) + ', contentStore: ' + JSON.stringify(contentStore) + ', resolveSnapshot: () => { fs.writeFileSync(' + JSON.stringify(resolved) + ', "resolved"); return ' + JSON.stringify(snapshot) + '; } });',
        ' try { fs.readFileSync(lease.snapshot + "/reader-source"); fs.writeFileSync(' + JSON.stringify(result) + ', "read"); } finally { lease.release(); }',
        '} catch { fs.writeFileSync(' + JSON.stringify(result) + ', "blocked"); }',
      ].join('\\n');
      child = spawn(${JSON.stringify(bun)}, ['--eval', source], { stdio: 'ignore' }); launched.push(child);
      await waitUntil(() => fs.existsSync(started));
      assert.equal(fs.existsSync(resolved), false);
      const exclusive = probeEditorViewLeaseUnderFence(input);
      try {
        assert.equal(exclusive.state, 'clear'); assert.equal(fs.existsSync(control), true);
        assert.equal(probe(), 'held'); assert.equal(fs.existsSync(resolved), false);
        if (outcome === 'retire') fs.rmSync(payload, { recursive: true });
      } finally { exclusive.release(); }
    });
    await waitUntil(() => fs.existsSync(result));
    assert.equal(fs.readFileSync(result, 'utf8'), outcome === 'retire' ? 'blocked' : 'read');
    await waitUntil(() => child.exitCode !== null);
    assert.equal(child.exitCode, 0);
  `),
  )

  it.each(['typescript', 'native'])(
    'reader lazily creates and shares a legacy control inside CAS: %s',
    (reader) =>
      run(`
    const reader = ${JSON.stringify(reader)};
    fs.rmSync(join(editorRoot, '.leases'), { recursive: true });
    assert.equal(probe(), 'unknown');
    const observation = observeEditorViewLeaseForRetirement(input);
    assert.equal(observation.kind, 'no-control'); observation.release();
    const ready = join(root, 'reader-backfill-ready');
    let child;
    await fence(async () => {
      if (reader === 'native') child = launch('mapped-hold', ready);
      else {
        const source = [
          'import * as fs from "node:fs";',
          'import { acquireEditorViewLease } from ' + JSON.stringify(${JSON.stringify(leaseModule)}) + ';',
          'const lease = await acquireEditorViewLease({ editorRoot: ' + JSON.stringify(editorRoot) + ', contentStore: ' + JSON.stringify(contentStore) + ', resolveSnapshot: () => ' + JSON.stringify(snapshot) + ' });',
          'fs.writeFileSync(' + JSON.stringify(ready) + ', "ready");',
          'process.stdin.resume();',
        ].join('\\n');
        child = spawn(${JSON.stringify(bun)}, ['--eval', source], { stdio: ['pipe', 'ignore', 'ignore'] }); launched.push(child);
      }
      await once(child, 'spawn'); assert.equal(fs.existsSync(control), false); assert.equal(fs.existsSync(ready), false);
    });
    await waitUntil(() => fs.existsSync(ready));
    assert.equal(probe(), 'held');
    assert.equal(fs.lstatSync(control).mode & 0o777, 0o600);
    await fence(async () => ensureEditorViewLeaseControl(input));
    child.kill('SIGKILL'); await waitUntil(() => probe() === 'clear');
  `),
  )

  it.each(['symlink', 'hardlink', 'permissions', 'replacement', 'directory'])(
    'fails closed for %s controls before importing command source',
    (unsafe) =>
      run(`
      const unsafe = ${JSON.stringify(unsafe)};
      const backup = control + '.backup'; fs.renameSync(control, backup);
      if (unsafe === 'symlink') fs.symlinkSync(backup, control);
      if (unsafe === 'hardlink') fs.linkSync(backup, control);
      if (unsafe === 'permissions') { fs.renameSync(backup, control); fs.chmodSync(control, 0o644); }
      if (unsafe === 'replacement') fs.copyFileSync(backup, control);
      if (unsafe === 'directory') fs.mkdirSync(control);
      assert.equal(probe(), 'unknown'); await assert.rejects(acquire());
      const observation = observeEditorViewLeaseForRetirement(input);
      assert.equal(observation.kind, 'unsafe');
      assert.equal(observation.state, 'unknown');
      observation.release();
      await fence(async () => {
        const final = probeEditorViewLeaseUnderFence(input);
        assert.equal(final.state, 'unknown'); final.release();
      });
      const marker = join(root, 'must-not-import');
      const command = spawnSync(launcher, ['--content-store', contentStore, '--editor-root', editorRoot, '--', ${JSON.stringify(bun)}, '--eval', 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "bad")'], { env: { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' } });
      assert.notEqual(command.status, 0); assert.equal(fs.existsSync(marker), false);
    `),
  )

  it('missing controls behind an unsafe control directory remain unknown and unmodified', () =>
    run(`
    fs.unlinkSync(control); fs.chmodSync(join(editorRoot, '.leases'), 0o777);
    const observation = observeEditorViewLeaseForRetirement(input);
    assert.equal(observation.state, 'unknown'); assert.equal(observation.kind, 'unsafe');
    observation.release(); assert.equal(fs.existsSync(control), false);
    await fence(async () => {
      const final = probeEditorViewLeaseUnderFence(input);
      assert.equal(final.state, 'unknown'); final.release();
    });
    assert.equal(fs.existsSync(control), false);
  `))

  it('fork plus exec retains SH after the original parent is SIGKILLed; last close releases', () =>
    run(`
    const ready = join(root, 'child.pid'); const parent = launch('fork', ready);
    let pid;
    try {
      await waitUntil(() => fs.existsSync(ready)); pid = Number(fs.readFileSync(ready, 'utf8'));
      assert.equal(probe(), 'held');
      parent.kill('SIGKILL'); await waitUntil(() => parent.signalCode !== null);
      assert.equal(probe(), 'held');
      process.kill(pid, 'SIGKILL'); pid = undefined;
      await waitUntil(() => probe() === 'clear');
    } finally { if (pid !== undefined) process.kill(pid, 'SIGKILL'); }
  `))

  it('normal exit and SIGKILL release the last holder', () =>
    run(`
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const ready = join(root, signal); const child = launch('hold', ready);
      await waitUntil(() => fs.existsSync(ready)); assert.equal(probe(), 'held');
      child.kill(signal); await waitUntil(() => probe() === 'clear');
    }
    const result = spawnSync(launcher, ['--content-store', contentStore, '--editor-root', editorRoot, '--', ${JSON.stringify(bun)}, '--eval', 'process.exit(0)'], { env: { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' } });
    assert.equal(result.status, 0); assert.equal(probe(), 'clear');
  `))

  it('unrelated exec children do not inherit default CLOEXEC primitive descriptors', () =>
    run(`
    const lease = await acquire(); const ready = join(root, 'unrelated');
    const child = spawn(helper, ['hold', ready], { stdio: 'ignore' }); launched.push(child);
    await waitUntil(() => fs.existsSync(ready)); lease.release();
    assert.equal(probe(), 'clear'); child.kill('SIGKILL');
  `))

  it('linked Git workspaces resolve and acquire inside their distinct owning CAS fences', () =>
    run(`
    const primary = join(root, 'primary'); const linked = join(root, 'linked');
    fs.mkdirSync(join(primary, '.git'), { recursive: true });
    fs.mkdirSync(linked);
    const administration = join(root, 'linked-administration');
    fs.mkdirSync(join(administration, 'worktrees', 'linked'), { recursive: true });
    fs.writeFileSync(join(linked, '.git'), 'gitdir: ../linked-administration/worktrees/linked\\n');
    fs.writeFileSync(join(administration, 'worktrees', 'linked', 'commondir'), '../..\\n');
    fs.mkdirSync(join(primary, 'repos'));
    fs.symlinkSync(linked, join(primary, 'repos', 'linked'));
    const firstRoot = join(primary, '.editor-view'); const secondRoot = join(linked, '.editor-view');
    const firstStore = join(primary, '.editor-view-content', 'v1');
    const secondStore = join(root, '.editor-view-content', 'v1');
    for (const [viewRoot, owner] of [[firstRoot, firstStore], [secondRoot, secondStore]]) {
      fs.mkdirSync(owner, { recursive: true });
      fs.mkdirSync(join(viewRoot, '.store', 'before'), { recursive: true });
      await withEditorViewContentStoreLock({ contentStore: owner, run: async () => {
        ensureEditorViewLeaseControl({ editorRoot: viewRoot, snapshot: 'before' });
      } });
      fs.symlinkSync('.store/before', join(viewRoot, 'default'));
    }
    fs.mkdirSync(join(secondRoot, '.store', 'after'));
    const { promise: entered, resolve: enter } = Promise.withResolvers();
    const { promise: proceed, resolve: releaseOwner } = Promise.withResolvers();
    const owner = withEditorViewContentStoreLock({ contentStore: secondStore, run: async () => {
      ensureEditorViewLeaseControl({ editorRoot: secondRoot, snapshot: 'after' });
      enter(); await proceed;
      fs.unlinkSync(join(secondRoot, 'default'));
      fs.symlinkSync('.store/after', join(secondRoot, 'default'));
      fs.rmSync(join(secondRoot, '.store', 'before'), { recursive: true });
    } });
    await entered;
    const ready = join(root, 'two-workspace-ready');
    const env = { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' };
    delete env.EDITOR_VIEW_CONTENT_STORE;
    const child = spawn(launcher, ['--workspace-root', primary, '--', helper, 'mapped-hold', ready], { env, stdio: 'ignore' });
    launched.push(child);
    try {
      await delay(50); assert.equal(fs.existsSync(ready), false);
      releaseOwner(); await owner; await waitUntil(() => fs.existsSync(ready));
      const first = probeEditorViewLease({ editorRoot: firstRoot, snapshot: 'before' });
      const second = probeEditorViewLease({ editorRoot: secondRoot, snapshot: 'after' });
      assert.equal(first.state, 'held'); assert.equal(second.state, 'held');
      first.release(); second.release(); child.kill('SIGKILL');
    } finally { releaseOwner(); await owner; }
  `))

  it('workspace launcher leases root and scoped generations and exports actual fd mappings', () =>
    run(`
    const scopedRoot = join(root, 'packages', '.editor-view');
    fs.mkdirSync(join(scopedRoot, '.store', snapshot), { recursive: true });
    await fence(async () => ensureEditorViewLeaseControl({ editorRoot: scopedRoot, snapshot }));
    fs.symlinkSync('.store/' + snapshot, join(scopedRoot, 'scoped'));
    const ready = join(root, 'workspace-ready');
    const child = spawn(launcher, ['--content-store', contentStore, '--workspace-root', root, '--', helper, 'mapped-hold', ready], { env: { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' }, stdio: 'ignore' }); launched.push(child);
    await waitUntil(() => fs.existsSync(ready)); assert.equal(probe(), 'held');
    const scoped = probeEditorViewLease({ editorRoot: scopedRoot, snapshot });
    assert.equal(scoped.state, 'held'); scoped.release(); child.kill('SIGKILL');
    await waitUntil(() => probe() === 'clear');
  `))

  it('cold inventory executes without creating a CAS fence; published generations require it', () =>
    run(`
    const cold = join(root, 'cold'); fs.mkdirSync(cold);
    const absentStore = join(root, 'absent-cas');
    const env = { ...process.env, EDITOR_VIEW_CONTENT_STORE: absentStore, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' };
    const command = [${JSON.stringify(bun)}, '--eval', 'process.exit(process.env.EDITOR_VIEW_LEASE_ACTIVE === "1" ? 0 : 1)'];
    const empty = spawnSync(launcher, ['--workspace-root', cold, '--', ...command], { env });
    assert.equal(empty.status, 0); assert.equal(fs.existsSync(absentStore + '.flock'), false);
    const published = spawnSync(launcher, ['--editor-root', editorRoot, '--', ...command], { env });
    assert.notEqual(published.status, 0); assert.equal(fs.existsSync(absentStore + '.flock'), false);
  `))

  it('unclassified filesystem cannot authorize a lease probe or command startup', () =>
    run(`
    const unsupported = process.platform === 'linux' ? '/proc' : '/dev';
    assert.equal(editorViewLeaseFilesystem(unsupported), 'unknown');
    const unknown = probeEditorViewLease({ editorRoot: unsupported, snapshot: 'not-a-generation' });
    assert.equal(unknown.state, 'unknown'); unknown.release();
    const result = spawnSync(launcher, ['--content-store', contentStore, '--editor-root', unsupported, '--', helper, 'hold', join(root, 'unknown')], { env: { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' } });
    assert.notEqual(result.status, 0);
  `))
})

describe.skipIf(process.platform !== 'darwin')('Darwin native dead-vnode proof', () => {
  const runProbe = (body: string): void =>
    run(`
      // bun:ffi is Bun-only; import it inside this Darwin-only subprocess, never in Vitest.
      const { dlopen } = await import('bun:ffi');
      const library = process.env.EDITOR_VIEW_LEASE_LIBRARY;
      assert.ok(library && isAbsolute(library), 'absolute packaged native library is required');
      const native = dlopen(library, {
        eu_darwin_dead_vnode: { args: ['i32', 'i32'], returns: 'i32' },
      });
      const deadVnode = (fd) => native.symbols.eu_darwin_dead_vnode(process.pid, fd);
      try { ${body} } finally { native.close(); }
    `)

  it('does not prove a live file dead', () =>
    runProbe(`
      const path = join(payload, 'live-file');
      fs.writeFileSync(path, 'still readable');
      const fd = fs.openSync(path, 'r');
      try {
        assert.equal(deadVnode(fd), 0);
        assert.equal(fs.readFileSync(fd, 'utf8'), 'still readable');
      } finally { fs.closeSync(fd); }
    `))

  it('does not prove an open unlinked file dead', () =>
    runProbe(`
      const path = join(payload, 'unlinked-file');
      fs.writeFileSync(path, 'still readable after unlink');
      const fd = fs.openSync(path, 'r');
      const before = fs.fstatSync(fd);
      try {
        fs.unlinkSync(path);
        assert.equal(deadVnode(fd), 0);
        assert.equal(fs.fstatSync(fd).ino, before.ino);
        assert.equal(fs.fstatSync(fd).dev, before.dev);
        assert.equal(fs.readFileSync(fd, 'utf8'), 'still readable after unlink');
      } finally { fs.closeSync(fd); }
    `))

  it('does not prove an open removed directory dead', () =>
    runProbe(`
      const path = join(payload, 'removed-directory');
      fs.mkdirSync(path);
      const fd = fs.openSync(path, 'r');
      const before = fs.fstatSync(fd);
      try {
        fs.rmdirSync(path);
        assert.equal(deadVnode(fd), 0);
        assert.equal(fs.fstatSync(fd).ino, before.ino);
        assert.equal(fs.fstatSync(fd).dev, before.dev);
        assert.equal(fs.fstatSync(fd).isDirectory(), true);
      } finally { fs.closeSync(fd); }
    `))

  it('does not prove directory or file descriptors dead after renaming their view parent', () =>
    runProbe(`
      const parent = join(payload, 'view-parent');
      fs.mkdirSync(parent);
      fs.writeFileSync(join(parent, 'source'), 'still readable after rename');
      const directory = fs.openSync(parent, 'r');
      const file = fs.openSync(join(parent, 'source'), 'r');
      const before = [directory, file].map((fd) => fs.fstatSync(fd));
      try {
        fs.renameSync(parent, parent + '-renamed');
        for (const [index, fd] of [directory, file].entries()) {
          assert.equal(deadVnode(fd), 0);
          assert.equal(fs.fstatSync(fd).ino, before[index].ino);
          assert.equal(fs.fstatSync(fd).dev, before[index].dev);
        }
        assert.equal(fs.readFileSync(file, 'utf8'), 'still readable after rename');
      } finally { fs.closeSync(file); fs.closeSync(directory); }
    `))

  it('logs kernel calls and errno without changing live-vnode evidence', () =>
    run(`
      const program = [
        "import { dlopen } from 'bun:ffi';",
        "import { openSync, closeSync } from 'node:fs';",
        "const native = dlopen(process.env.EDITOR_VIEW_LEASE_LIBRARY, { eu_darwin_log_unknown: { args: ['i32', 'i32'], returns: 'void' }, eu_darwin_dead_vnode: { args: ['i32', 'i32'], returns: 'i32' } });",
        "const fd = openSync(" + JSON.stringify(payload) + ", 'r');",
        "native.symbols.eu_darwin_log_unknown(process.pid, fd);",
        "process.stdout.write(String(native.symbols.eu_darwin_dead_vnode(process.pid, fd)));",
        "closeSync(fd); native.close();",
      ].join("\\n");
      const observed = spawnSync(process.execPath, ['--eval', program], { encoding: 'utf8', env: process.env });
      assert.equal(observed.status, 0, observed.stderr);
      assert.equal(observed.stdout, '0');
      for (const call of ['PROC_PIDTBSDINFO-before', 'PROC_PIDLISTFDS', 'PROC_PIDFDVNODEINFO', 'PROC_PIDFDVNODEPATHINFO', 'PROC_PIDTBSDINFO-after'])
        assert.match(observed.stderr, new RegExp('editor-view-reader-kernel: pid=\\\\d+ comm=\\\\S+ fd=\\\\d+ call=' + call + ' result=\\\\d+ errno=\\\\d+'));
    `))

  it('does not mistake an invalid or closed descriptor for a proven dead vnode', () =>
    runProbe(`
      assert.equal(deadVnode(-1), 0);
      const fd = fs.openSync(payload, 'r');
      fs.closeSync(fd);
      assert.equal(deadVnode(fd), 0);
    `))
})
