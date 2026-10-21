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

// Bun is the actual FFI runtime. Vitest itself need not import bun:ffi.
const run = (body: string): void => {
  const source = `
    import assert from 'node:assert/strict';
    import * as fs from 'node:fs';
    import { join } from 'node:path';
    import { tmpdir } from 'node:os';
    import { spawn, spawnSync } from 'node:child_process';
    import { setTimeout as delay } from 'node:timers/promises';
    import { acquireEditorViewLease, ensureEditorViewLeaseControl, probeEditorViewLease, editorViewLeaseFilesystem } from ${JSON.stringify(leaseModule)};
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
  it('concurrent SH excludes EX; closing one inherited description never unlocks another', () =>
    run(`
    const left = await acquire(); const right = await acquire();
    assert.equal(probe(), 'held');
    left.release(); left.release(); assert.equal(probe(), 'held');
    right.release(); assert.equal(probe(), 'clear');
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

  it('explicit native legacy backfill creates controls without replacing tombstones or executing source', () =>
    run(`
    fs.rmSync(join(editorRoot, '.leases'), { recursive: true });
    assert.equal(probe(), 'unknown');
    const env = { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' };
    const args = ['--content-store', contentStore, '--workspace-root', root, '--backfill-controls'];
    assert.equal(spawnSync(launcher, args, { env }).status, 0);
    assert.equal(fs.lstatSync(control).mode & 0o777, 0o600);
    const inode = fs.lstatSync(control).ino;
    await fence(async () => ensureEditorViewLeaseControl(input));
    assert.equal(spawnSync(launcher, args, { env }).status, 0);
    assert.equal(fs.lstatSync(control).ino, inode);
    const reader = await acquire(); assert.equal(probe(), 'held'); reader.release();
    const marker = join(root, 'no-backfill-exec');
    const rejected = spawnSync(launcher, [...args, '--', ${JSON.stringify(bun)}, '--eval', 'require(\"node:fs\").writeFileSync(' + JSON.stringify(marker) + ', \"bad\")'], { env });
    assert.notEqual(rejected.status, 0); assert.equal(fs.existsSync(marker), false);
    fs.writeFileSync(control, 'replaced');
    assert.notEqual(spawnSync(launcher, args, { env }).status, 0);
    assert.equal(fs.readFileSync(control, 'utf8'), 'replaced');
    const missing = spawnSync(launcher, ['--content-store', join(root, 'absent-cas'), '--editor-root', editorRoot, '--backfill-controls'], { env });
    assert.notEqual(missing.status, 0); assert.equal(fs.existsSync(join(root, 'absent-cas.flock')), false);
  `))

  it.each(['missing', 'symlink', 'hardlink', 'permissions', 'replacement', 'directory'])(
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
      const marker = join(root, 'must-not-import');
      const command = spawnSync(launcher, ['--content-store', contentStore, '--editor-root', editorRoot, '--', ${JSON.stringify(bun)}, '--eval', 'require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "bad")'], { env: { ...process.env, EDITOR_VIEW_LEASE_EXECUTABLE: '', EDITOR_VIEW_LEASE_FDS: '' } });
      assert.notEqual(command.status, 0); assert.equal(fs.existsSync(marker), false);
    `),
  )

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
    const command = [${JSON.stringify(bun)}, '--eval', 'process.exit(process.env.EDITOR_VIEW_LEASE_ACTIVE === \"1\" ? 0 : 1)'];
    const empty = spawnSync(launcher, ['--workspace-root', cold, '--', ...command], { env });
    assert.equal(empty.status, 0); assert.equal(fs.existsSync(absentStore + '.flock'), false);
    const backfill = spawnSync(launcher, ['--workspace-root', cold, '--backfill-controls'], { env });
    assert.equal(backfill.status, 0); assert.equal(fs.existsSync(absentStore + '.flock'), false);
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
