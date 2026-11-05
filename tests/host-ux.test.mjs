import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostPaths, replaceFile, digest } from '../src/host-files.mjs';
import { hostBlock, registerHost } from '../src/ssh-config.mjs';
import { parseHostArgs } from '../src/host-cli.mjs';
import { generateClientKeyPair } from '../src/keys.mjs';
import { fixture } from './fixtures/ssh.mjs';
import { ensurePrivateStateDir, writeStateAtomically } from '../src/state.mjs';
const exec = promisify(execFile);

test('generated SSH alias resolves real OpenSSH settings, preserves original config, and is idempotent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "emdash host's "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = hostPaths('sample', root), key = await generateClientKeyPair();
  const configFile = path.join(root, '.ssh/config');
  await fs.mkdir(path.dirname(configFile), { mode: 0o700 });
  const original = 'Host existing\n  HostName existing.example\n  User someone\n';
  await fs.writeFile(configFile, original);
  await registerHost(paths, { hostPublicKey: key.publicKey }, { configFile });
  const result = await exec('ssh', ['-G', '-F', configFile, paths.alias]);
  assert.match(result.stdout, /^hostname 127\.0\.0\.1$/m);
  assert.match(result.stdout, /^user emdash$/m); assert.match(result.stdout, /^port 2222$/m);
  assert.match(result.stdout, /proxycommand .*proxy.*--state-dir/);
  assert.match(result.stdout, /stricthostkeychecking true/);
  const generated = await fs.readFile(configFile);
  assert.ok(generated.toString().endsWith(original));
  await registerHost(paths, { hostPublicKey: key.publicKey }, { configFile });
  assert.deepEqual(await fs.readFile(configFile), generated);
  const existing = await exec('ssh', ['-G', '-F', configFile, 'existing']);
  assert.match(existing.stdout, /^hostname existing\.example$/m);
  const wrong = await generateClientKeyPair();
  await assert.rejects(registerHost(paths, { hostPublicKey: wrong.publicKey }, { configFile }), /identity mismatch/);
});

test('registration refuses duplicate aliases and symlinks; guarded writes reject stale edits', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emdash-config-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = hostPaths('sample', root), key = await generateClientKeyPair(), configFile = path.join(root, 'config');
  await fs.writeFile(configFile, 'Host vercel-sample\n HostName keep.example\n');
  await assert.rejects(registerHost(paths, { hostPublicKey: key.publicKey }, { configFile }), /already exists/);
  const original = await fs.readFile(configFile);
  const symlink = path.join(root, 'link'); await fs.symlink(configFile, symlink);
  await assert.rejects(registerHost(paths, { hostPublicKey: key.publicKey }, { configFile: symlink }), /ELOOP/);
  await fs.writeFile(configFile, 'user edit\n');
  await assert.rejects(replaceFile(configFile, 'overwrite', digest(original), path.join(paths.directory, 'receipts')), /STALE_PRECONDITION/);
  assert.equal(await fs.readFile(configFile, 'utf8'), 'user edit\n');
});

test('host commands reject invalid arguments before setup and keep deletion outside the named-host flow', () => {
  for (const argv of [['setup', '--name', '../escape'], ['setup', '--wat', 'yes'], ['setup', '--use-cli'], ['setup', '--timeout-minutes', '0'], ['start'], ['stop', '--host', 'a', '--host', 'b'], ['proxy', '--state-dir', 'relative'], ['destroy', '--host', 'a']]) assert.throws(() => parseHostArgs(argv));
  assert.deepEqual(parseHostArgs(['setup', '--name', 'test', '--yes']).flags, { name: 'test', yes: true });
  assert.throws(() => hostBlock(hostPaths('sample', '/tmp/path%h')), /without/);
});

test('task list reads managed-clone task registration and excludes unrelated repositories', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'emdash-tasks-'))); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), worktrees = path.join(root, 'emdash/worktrees'), managed = path.join(root, 'emdash/repositories/project');
  await fs.mkdir(project); await exec('git', ['init', '-b', 'main', project]);
  await fs.writeFile(path.join(project, 'file'), 'original');
  await exec('git', ['-C', project, 'add', '.']); await exec('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'initial']);
  await fs.mkdir(path.dirname(managed), { recursive: true }); await exec('git', ['clone', project, managed]);
  const task = path.join(worktrees, 'project/task'); await fs.mkdir(path.dirname(task), { recursive: true });
  await exec('git', ['-C', managed, 'worktree', 'add', '-b', 'emdash/task', task]);
  const script = path.resolve('src/assets/list-worktrees.py');
  const code = 'import runpy,json,sys; m=runpy.run_path(sys.argv[1]); print(json.dumps(m["list_worktrees"](sys.argv[2],sys.argv[3])))';
  const list = async () => JSON.parse((await exec('python3', ['-c', code, script, project, worktrees])).stdout);
  assert.deepEqual((await list()).map(x => x.path).sort(), [project, task].sort());
  await exec('git', ['-C', managed, 'remote', 'set-url', 'origin', '/different/project']);
  assert.deepEqual((await list()).map(x => x.path), [project]);
});


test('OpenSSH executes the installed-style on-demand proxy without a foreground relay', { timeout: 25000 }, async t => {
  const f = await fixture(t, { innerSsh: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "emdash live's ")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = hostPaths('stdio', root);
  await ensurePrivateStateDir(paths.stateDir);
  await fs.writeFile(path.join(paths.stateDir, 'id_ed25519'), f.options.privateKey, { mode: 0o600 });
  const state = { schemaVersion: '1', id: 'fixture', name: 'fixture', teamId: 'team', projectId: 'project', bridgeToken: f.options.bridgeToken, status: 'running', relayPort: 22222, url: f.options.bridgeUrl, hostPublicKey: f.options.hostPublicKey };
  await writeStateAtomically(paths.stateDir, state);
  const configFile = path.join(root, '.ssh/config');
  await registerHost(paths, state, { configFile });
  const result = await exec('ssh', ['-F', configFile, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', paths.alias, 'true'], { timeout: 15000 });
  assert.equal(result.stdout, 'proxy-command-ok\n');
  assert.equal(f.forwarded(), 1);
});


test('quoted and included SSH aliases are refused without changing existing configuration', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emdash quoted-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = hostPaths('sample', root), key = await generateClientKeyPair(), configFile = path.join(root, 'config');
  for (const hostLine of ['Host "vercel-sample"', 'Host = "vercel-sample"', "Host 'vercel-sample'"]) {
    const original = hostLine + '\n HostName keep.example\n';
    await fs.writeFile(configFile, original);
    assert.match((await exec('ssh', ['-G', '-F', configFile, paths.alias])).stdout, /^hostname keep\.example$/m);
    await assert.rejects(registerHost(paths, { hostPublicKey: key.publicKey }, { configFile }), /already exists/);
    assert.equal(await fs.readFile(configFile, 'utf8'), original);
  }
  const included = path.join(root, 'extra.conf');
  await fs.writeFile(included, 'Host "vercel-sample"\n HostName included.example\n');
  const original = 'Include "' + included + '"\n'; await fs.writeFile(configFile, original);
  await assert.rejects(registerHost(paths, { hostPublicKey: key.publicKey }, { configFile }), /already exists/);
  assert.equal(await fs.readFile(configFile, 'utf8'), original);
});
