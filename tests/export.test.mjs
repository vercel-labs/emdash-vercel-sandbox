import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { assetPath } from '../src/paths.mjs';
import { buildExportCommand, EXPORT_LIMITS, publishExport, restoreExportManifest, validateExportManifest, validateExportSelection } from '../src/export.mjs';

const exec = promisify(execFile);
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_NAME: 'Export test', GIT_AUTHOR_EMAIL: 'export@example.invalid',
  GIT_COMMITTER_NAME: 'Export test', GIT_COMMITTER_EMAIL: 'export@example.invalid' };
const git = async (dir, ...args) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { env, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
const textGit = async (dir, ...args) => (await git(dir, ...args)).toString().trim();

async function fixture(t) {
  const temp = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'emdash-export-test-')));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'project');
  const worktrees = path.join(temp, 'worktrees');
  await fsp.mkdir(project);
  await fsp.mkdir(worktrees);
  await git(project, 'init', '--template=', '-b', 'main');
  await fsp.writeFile(path.join(project, '.gitignore'), '*.ignored\n');
  await fsp.writeFile(path.join(project, 'mixed file\nname.txt'), 'base\n');
  await fsp.writeFile(path.join(project, 'unstaged-delete'), 'gone later\n');
  await fsp.writeFile(path.join(project, 'staged-delete'), 'gone staged\n');
  await fsp.writeFile(path.join(project, 'binary.dat'), Buffer.from([0, 128, 255, 10]));
  await git(project, 'add', '.');
  await git(project, 'commit', '-m', 'initial');
  await git(project, 'tag', 'baseline');
  await fsp.writeFile(path.join(project, 'second'), 'second commit\n');
  await git(project, 'add', '.');
  await git(project, 'commit', '-m', 'second');
  await git(project, 'branch', 'other-history', 'HEAD~1');
  await git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return { temp, project, worktrees, stateDir: path.join(temp, 'private-state') };
}

async function capture(f, selection = f.project) {
  // Test-only injected roots exercise the actual exporter without /home, SSH or credentials.
  const script = "import runpy,sys; m=runpy.run_path(sys.argv[1]); print(m['create_manifest'](sys.argv[2], (sys.argv[3],sys.argv[4])))";
  const { stdout } = await exec('python3', ['-c', script, assetPath('export-project.py'), selection, f.project, f.worktrees],
    { env, maxBuffer: EXPORT_LIMITS.manifest + 1024, timeout: 120000 });
  return stdout;
}

async function dirty(repo) {
  await fsp.writeFile(path.join(repo, 'mixed file\nname.txt'), 'staged\n');
  await fsp.writeFile(path.join(repo, 'added binary\nfile'), Buffer.from([255, 0, 17, 255]));
  await git(repo, 'add', '.');
  await fsp.writeFile(path.join(repo, 'mixed file\nname.txt'), 'unstaged\n');
  await fsp.writeFile(path.join(repo, 'added binary\nfile'), Buffer.from([255, 0, 18, 254]));
  await git(repo, 'rm', 'staged-delete');
  await fsp.unlink(path.join(repo, 'unstaged-delete'));
  await fsp.chmod(path.join(repo, 'second'), 0o755);
  await fsp.writeFile(path.join(repo, 'untracked file\nwith newline'), Buffer.from([0, 1, 128]));
  await fsp.writeFile(path.join(repo, 'private.ignored'), 'must not export');
  await fsp.mkdir(path.join(repo, 'links'));
  await fsp.symlink('../mixed file\nname.txt', path.join(repo, 'links', 'safe link'));
}

async function assertEquivalent(source, output) {
  const indexPath = await textGit(source, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  assert.deepEqual(await fsp.readFile(path.join(output, '.git', 'index')), await fsp.readFile(indexPath));
  for (const args of [['rev-parse', 'HEAD'], ['show-ref'], ['log', '--all', '--format=%H'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'], ['diff', '--binary'], ['diff', '--cached', '--binary'],
    ['ls-files', '--stage', '-z']]) {
    assert.deepEqual(await git(output, ...args), await git(source, ...args), args.join(' '));
  }
  await git(output, 'fsck', '--full');
  assert.equal((await fsp.stat(path.join(output, '.git'))).isDirectory(), true);
}

test('round trips history, refs, branch, staging, deletions, binary, modes, links and unusual names', async t => {
  const f = await fixture(t);
  await dirty(f.project);
  const manifest = await capture(f);
  const destination = path.join(f.temp, 'export');
  const result = await restoreExportManifest(manifest, destination, { stateDir: f.stateDir, expectedSelection: f.project });
  assert.equal(result.branch, 'refs/heads/main');
  await assertEquivalent(f.project, destination);
  assert.deepEqual(await fsp.readFile(path.join(destination, 'untracked file\nwith newline')), Buffer.from([0, 1, 128]));
  assert.equal(await fsp.readlink(path.join(destination, 'links', 'safe link')), '../mixed file\nname.txt');
  assert.equal((await fsp.stat(path.join(destination, 'second'))).mode & 0o777, 0o755);
  await assert.rejects(fsp.lstat(path.join(destination, 'private.ignored')), { code: 'ENOENT' });
  assert.equal((await textGit(destination, 'config', '--local', '--list')).includes('remote.origin.url'), false);
});

test('exports only the exact linked worktree and retains sibling history with a standalone index', async t => {
  const f = await fixture(t);
  const selected = path.join(f.worktrees, "selected space ' quote\nline");
  await git(f.project, 'worktree', 'add', '-b', 'task/selected', selected);
  await fsp.writeFile(path.join(f.project, 'do-not-export'), 'main only');
  await dirty(selected);
  const destination = path.join(f.temp, 'selected-export');
  await restoreExportManifest(await capture(f, selected), destination, { stateDir: f.stateDir });
  await assertEquivalent(selected, destination);
  await assert.rejects(fsp.lstat(path.join(destination, 'do-not-export')), { code: 'ENOENT' });
  assert.equal(await textGit(destination, 'symbolic-ref', 'HEAD'), 'refs/heads/task/selected');
});

test('detached HEAD commit survives without a branch reference', async t => {
  const f = await fixture(t);
  await git(f.project, 'checkout', '--detach');
  await fsp.writeFile(path.join(f.project, 'detached'), 'detached commit\n');
  await git(f.project, 'add', '.');
  await git(f.project, 'commit', '-m', 'detached only');
  const destination = path.join(f.temp, 'detached-export');
  const result = await restoreExportManifest(await capture(f), destination, { stateDir: f.stateDir });
  assert.equal(result.branch, null);
  await assertEquivalent(f.project, destination);
  await assert.rejects(git(destination, 'symbolic-ref', 'HEAD'));
});

test('version 4 index, intent-to-add and staged symlink/executable preserve index semantics', async t => {
  const f = await fixture(t);
  await fsp.writeFile(path.join(f.project, 'intent to add'), 'intent\n');
  await git(f.project, 'add', '-N', 'intent to add');
  await fsp.chmod(path.join(f.project, 'second'), 0o755);
  await fsp.symlink('second', path.join(f.project, 'staged-link'));
  await git(f.project, 'add', 'second', 'staged-link');
  await git(f.project, 'update-index', '--index-version=4');
  const destination = path.join(f.temp, 'v4-export');
  await restoreExportManifest(await capture(f), destination, { stateDir: f.stateDir });
  await assertEquivalent(f.project, destination);
});

test('exact selection rejects traversal, aliases, nested repositories and unregistered worktrees', async t => {
  for (const value of ['task-name', '/home/emdash/project/../secret', '/home/emdash/project/', '/home/emdash/project//x',
    '/home/emdash/project/.git', '/home/emdash/project-elsewhere', '/etc']) assert.throws(() => validateExportSelection(value));
  assert.equal(validateExportSelection(), '/home/emdash/project');
  assert.equal(validateExportSelection('/home/emdash/emdash/worktrees/a b\nc'), '/home/emdash/emdash/worktrees/a b\nc');
  const f = await fixture(t);
  const nested = path.join(f.project, 'nested');
  await fsp.mkdir(nested);
  await git(nested, 'init', '--template=');
  await assert.rejects(capture(f, nested), /not a registered/);
  await assert.rejects(capture(f, f.project + '/'), /exact absolute/);
  const alias = path.join(f.worktrees, 'alias');
  await fsp.symlink(f.project, alias);
  await assert.rejects(capture(f, alias), /exact absolute/);
});

test('rejects unsafe manifest paths and symlinks before any local directory is created', async t => {
  const f = await fixture(t);
  const clean = JSON.parse(await capture(f));
  const file = name => ({ path: name, type: 'file', mode: 0o644, data: '' });
  const invalid = [
    [file('../escape')], [file('/absolute')], [file('.git/config')], [file('d/.GiT/config')], [file('.g\u200cit/hooks/pre-commit')], [file('git~1/hooks/hook')], [file('x\\y')],
    [file('x'), file('x')], [file('x'), file('x/child')], [file('A/one'), file('a/two')],
    [{ path: 'link', type: 'symlink', target: '../../escape' }],
    [{ path: 'link', type: 'symlink', target: '/etc/passwd' }],
    [{ path: 'link', type: 'symlink', target: '.git/config' }],
    [{ path: 'link', type: 'symlink', target: 'link' }],
    [{ path: 'a', type: 'symlink', target: '.' }, { path: 'd/link', type: 'symlink', target: '../a/../outside' }],
    [{ path: 'link', type: 'symlink', target: 'second' }, file('link/child')],
    [{ path: 'fifo', type: 'fifo' }], [{ ...file('setuid'), mode: 0o4755 }]
  ];
  const before = await fsp.readdir(f.temp);
  for (const entries of invalid) {
    await assert.rejects(restoreExportManifest(JSON.stringify({ ...clean, entries }), path.join(f.temp, 'bad'), { stateDir: f.stateDir }));
  }
  assert.deepEqual(await fsp.readdir(f.temp), before);
});

test('rejects corrupted index, missing staged blobs, bad object hashes, bundle corruption and limits', async t => {
  const f = await fixture(t);
  const m = JSON.parse(await capture(f));
  const invalid = [
    { ...m, index: Buffer.from('bad index').toString('base64') }, { ...m, indexBlobs: [] },
    { ...m, indexBlobs: [{ oid: m.indexBlobs[0].oid, data: 'YQ==' }] },
    { ...m, bundle: m.bundle.slice(0, -4) + 'AAAA' },
    { ...m, head: '0'.repeat(40) }, { ...m, branch: 'refs/heads/../escape' },
    { ...m, entries: Array(EXPORT_LIMITS.entries + 1).fill(null) },
    { ...m, entries: [{ path: 'big', type: 'file', mode: 0o644, data: Buffer.alloc(EXPORT_LIMITS.file + 1).toString('base64') }] }
  ];
  const before = await fsp.readdir(f.temp);
  for (const item of invalid) {
    await assert.rejects(restoreExportManifest(JSON.stringify(item), path.join(f.temp, 'invalid'), { stateDir: f.stateDir }));
  }
  assert.deepEqual(await fsp.readdir(f.temp), before);
  assert.throws(() => validateExportManifest(JSON.stringify(m), '/different-selection'));
});

test('remote rejects unsafe links, large files, shallow history, split index and submodules', async t => {
  const f = await fixture(t);
  await fsp.symlink('/etc/passwd', path.join(f.project, 'unsafe'));
  await assert.rejects(capture(f), /Unsafe symlink/);
  await fsp.unlink(path.join(f.project, 'unsafe'));
  const big = await fsp.open(path.join(f.project, 'big'), 'w');
  await big.truncate(EXPORT_LIMITS.file + 1); await big.close();
  await assert.rejects(capture(f), /exceeds 8 MiB/);
  await fsp.unlink(path.join(f.project, 'big'));
  await git(f.project, 'update-index', '--split-index');
  await assert.rejects(capture(f), /Split index/);
  await git(f.project, 'update-index', '--no-split-index');
  await git(f.project, 'update-index', '--add', '--cacheinfo', `160000,${await textGit(f.project, 'rev-parse', 'HEAD')},submodule`);
  await assert.rejects(capture(f), /Submodules/);
  await git(f.project, 'update-index', '--force-remove', 'submodule');
  await fsp.writeFile(path.join(f.project, '.git', 'shallow'), await git(f.project, 'rev-parse', 'HEAD'));
  await assert.rejects(capture(f), /Shallow history/);
});

test('never overwrites existing directories, files or dangling symlinks', async t => {
  const f = await fixture(t); const m = await capture(f);
  for (const kind of ['dir', 'file', 'link']) {
    const dest = path.join(f.temp, kind);
    if (kind === 'dir') await fsp.mkdir(dest);
    else if (kind === 'file') await fsp.writeFile(dest, 'preserve');
    else await fsp.symlink('nonexistent', dest);
    await assert.rejects(restoreExportManifest(m, dest, { stateDir: f.stateDir }), /already exists/);
  }
  assert.equal(await fsp.readFile(path.join(f.temp, 'file'), 'utf8'), 'preserve');
  assert.equal(await fsp.readlink(path.join(f.temp, 'link')), 'nonexistent');
  assert.deepEqual(await fsp.readdir(path.join(f.temp, 'dir')), []);
});

test('Git semantic failure cleans only owned staging and leaves destination absent', async t => {
  const f = await fixture(t); const m = JSON.parse(await capture(f));
  const badHead = m.indexBlobs[0].oid;
  m.bundle = Buffer.from(Buffer.from(m.bundle, 'base64').toString('binary').replaceAll(m.head, badHead), 'binary').toString('base64');
  m.head = badHead;
  const before = await fsp.readdir(f.temp);
  await assert.rejects(restoreExportManifest(JSON.stringify(m), path.join(f.temp, 'failed'), { stateDir: f.stateDir }));
  assert.deepEqual(await fsp.readdir(f.temp), before);
});


test('shell command preserves Python code and literal worktree arguments', async () => {
  const selection = "/home/emdash/emdash/worktrees/quote ' \" ; $(printf injected) `printf injected` \nline";
  const helper = "import json,sys; print(json.dumps({'args':sys.argv[1:], 'quote':\"a'b\"}))";
  const { stdout } = await exec('/bin/sh', ['-c', buildExportCommand(helper, selection)]);
  assert.deepEqual(JSON.parse(stdout), { args: [selection], quote: "a'b" });
});

test('an 8 MiB binary at the file limit round trips without a base64 parser stack overflow', async t => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(EXPORT_LIMITS.file, 0xa5);
  await fsp.writeFile(path.join(f.project, 'at-limit.bin'), bytes);
  const destination = path.join(f.temp, 'large-export');
  await restoreExportManifest(await capture(f), destination, { stateDir: f.stateDir });
  assert.deepEqual(await fsp.readFile(path.join(destination, 'at-limit.bin')), bytes);
});

test('a destination created during reconstruction is preserved and staging is cleaned', async t => {
  const f = await fixture(t);
  const manifest = await capture(f);
  const destination = path.join(f.temp, 'raced-export');
  let created = false;
  let failure;
  const watcher = setInterval(async () => {
    if (created) return;
    const names = await fsp.readdir(f.temp);
    if (!created && names.some(name => name.startsWith('.emdash-export-'))) {
      created = true;
      try { await fsp.mkdir(destination); } catch (error) { failure = error; }
    }
  }, 1);
  try {
    await assert.rejects(restoreExportManifest(manifest, destination, { stateDir: f.stateDir }), { code: 'EEXIST' });
  } finally { clearInterval(watcher); }
  assert.equal(created, true);
  assert.equal(failure, undefined);
  assert.deepEqual(await fsp.readdir(destination), []);
  assert.equal((await fsp.readdir(f.temp)).some(name => name.startsWith('.emdash-export-')), false);
});


test('file-directory replacements preserve tracked deletions without following ancestors', async t => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.project, 'directory'));
  await fsp.writeFile(path.join(f.project, 'directory', 'tracked'), 'tracked child');
  await git(f.project, 'add', '.');
  await git(f.project, 'commit', '-m', 'directory fixture');
  await fsp.rm(path.join(f.project, 'directory'), { recursive: true });
  await fsp.writeFile(path.join(f.project, 'directory'), 'now a regular file');
  await fsp.unlink(path.join(f.project, 'second'));
  await fsp.mkdir(path.join(f.project, 'second'));
  await fsp.writeFile(path.join(f.project, 'second', 'untracked'), 'now a directory');
  const destination = path.join(f.temp, 'types-export');
  await restoreExportManifest(await capture(f), destination, { stateDir: f.stateDir });
  await assertEquivalent(f.project, destination);
});

test('publication failure leaves no destination and permits a complete retry', async t => {
  const f = await fixture(t), manifest = await capture(f);
  const destination = path.join(f.temp, 'failed-export');
  await assert.rejects(restoreExportManifest(manifest,destination,{stateDir:f.stateDir,
    publish: async () => {throw new Error('Injected publication failure');}}), /Injected publication failure/);
  await assert.rejects(fsp.lstat(destination),{code:'ENOENT'});
  await restoreExportManifest(manifest,destination,{stateDir:f.stateDir});
  await assertEquivalent(f.project,destination);
});

test('atomic publication preserves a concurrent same-name file and an empty destination', async t => {
  const f = await fixture(t), manifest = await capture(f);
  for (const withFile of [false,true]) {
    const destination = path.join(f.temp,withFile ? 'same-name-race':'empty-race');
    await assert.rejects(restoreExportManifest(manifest,destination,{stateDir:f.stateDir,
      publish: async (source,target) => {
        await fsp.mkdir(target);
        if (withFile) await fsp.writeFile(path.join(target,'second'),'concurrent work');
        await publishExport(source,target);
      }}), {code:'EEXIST'});
    assert.deepEqual(await fsp.readdir(destination),withFile ? ['second']:[]);
    if (withFile) assert.equal(await fsp.readFile(path.join(destination,'second'),'utf8'),'concurrent work');
  }
});

test('remote export rejection surfaces bounded reason, redacts resolved secrets and closes connection', async t => {
  const {exportProject} = await import('../src/export.mjs');
  const oldKey = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = 'fixture-export-gateway';
  t.after(() => { if (oldKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldKey; });
  let closed = false;
  await assert.rejects(exportProject({state:{bridgeToken:'fixture-export-bridge'}, credentials:{token:'fixture-export-control'},
    stateDir:'/private/tmp/private-state',destination:'/private/tmp/export-diagnostic-test'}, async () => ({
      exec: async () => {throw Object.assign(new Error('Remote command failed'), {
        stderr:'x'.repeat(12000) + 'Export failed: Index exceeds 4 MiB fixture-export-gateway fixture-export-bridge fixture-export-control', exitCode:1,
      });}, close: () => {closed = true;},
    })), error => {
      assert.match(error.message,/Export failed: Index exceeds 4 MiB/);
      assert.ok(error.message.length < 8100);
      for (const secret of ['fixture-export-gateway','fixture-export-bridge','fixture-export-control']) assert.equal(error.message.includes(secret),false);
      return true;
    });
  assert.equal(closed,true);
});


test('termination immediately before or after atomic publication leaves absent or complete output', async t => {
  const f = await fixture(t), manifest = await capture(f);
  const manifestPath = path.join(f.temp,'manifest.json');
  await fsp.writeFile(manifestPath,manifest);
  for (const after of [false,true]) {
    const destination = path.join(f.temp,after ? 'after-publish':'before-publish');
    const moduleUrl = new URL('../src/export.mjs',import.meta.url).href;
    const code = `
      import fsp from 'node:fs/promises';
      const {restoreExportManifest,publishExport} = await import(${JSON.stringify(moduleUrl)});
      await restoreExportManifest(await fsp.readFile(${JSON.stringify(manifestPath)},'utf8'),
        ${JSON.stringify(destination)},{stateDir:${JSON.stringify(f.stateDir)},publish:async(source,target)=>{
          if (${JSON.stringify(after)}) await publishExport(source,target);
          process.kill(process.pid,'SIGKILL');
        }});
    `;
    await assert.rejects(exec(process.execPath,['--input-type=module','-e',code],{env}),error=>error.signal==='SIGKILL');
    if (after) await assertEquivalent(f.project,destination);
    else await assert.rejects(fsp.lstat(destination),{code:'ENOENT'});
  }
});

test('exports a task from the managed project clone with dirty files and history intact', async t => {
  const f = await fixture(t);
  const managed = path.join(f.temp, 'repositories', 'project');
  await fsp.mkdir(path.dirname(managed));
  await git(f.temp, 'clone', '--no-local', '--template=', f.project, managed);
  const selected = path.join(f.worktrees, 'managed-task');
  await git(managed, 'worktree', 'add', '-b', 'task/managed', selected);
  await dirty(selected);
  await fsp.writeFile(path.join(managed, 'sibling-only'), 'do not export');
  const destination = path.join(f.temp, 'managed-export');
  const result = await restoreExportManifest(await capture(f, selected), destination, { stateDir: f.stateDir });
  assert.equal(result.branch, 'refs/heads/task/managed');
  await assertEquivalent(selected, destination);
  await assert.rejects(fsp.lstat(path.join(destination, 'sibling-only')), { code: 'ENOENT' });
  await assert.rejects(fsp.lstat(path.join(destination, 'private.ignored')), { code: 'ENOENT' });
});

test('managed-copy support rejects a different origin and an unregistered selection', async t => {
  const f = await fixture(t);
  const managed = path.join(f.temp, 'repositories', 'project');
  await fsp.mkdir(path.dirname(managed));
  await git(f.temp, 'clone', '--no-local', '--template=', f.project, managed);
  const selected = path.join(f.worktrees, 'managed-task');
  await git(managed, 'worktree', 'add', '-b', 'task/managed', selected);
  await git(managed, 'remote', 'set-url', 'origin', path.join(f.temp, 'different-project'));
  await assert.rejects(capture(f, selected), /not a registered/);
  await git(managed, 'remote', 'set-url', 'origin', f.project);
  const unrelated = path.join(f.worktrees, 'unregistered');
  await fsp.mkdir(unrelated);
  await git(unrelated, 'init', '--template=');
  await assert.rejects(capture(f, unrelated), /not a registered/);
});
