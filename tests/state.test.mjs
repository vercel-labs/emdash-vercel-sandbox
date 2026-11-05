import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redactResolvedCredentials } from '../src/credentials.mjs';
import { ensurePrivateStateDir, withStateLock, writeStateAtomically, readState, removeStateArtifacts, recoverStateLock } from '../src/state.mjs';
import { runRemote } from '../src/lifecycle.mjs';
import { assertOwnedSandbox } from '../src/sandbox.mjs';

async function directory(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'emdash-state-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

function state() {
  return {schemaVersion:'1',id:'test',name:'test-host',teamId:'team',projectId:'project',bridgeToken:'token',url:'',hostPublicKey:'',status:'creating',relayPort:22222};
}

async function writeLock(stateDirectory, owner) {
  const lockPath = path.join(stateDirectory, '.launcher.lock');
  const bytes = Buffer.from(JSON.stringify(owner) + '\n');
  await fsp.writeFile(lockPath, bytes, { mode: 0o600 });
  const stats = await fsp.stat(lockPath);
  return { lockPath, bytes, hash: createHash('sha256').update(bytes).digest('hex'), inode: stats.ino };
}

test('creating state is recoverable and atomic receipts contain hashes', async t => {
  const stateDirectory = await directory(t);
  await ensurePrivateStateDir(stateDirectory);
  await withStateLock(stateDirectory, () => writeStateAtomically(stateDirectory, state()));
  assert.equal((await readState(stateDirectory)).status, 'creating');
  assert.equal((await fsp.stat(path.join(stateDirectory, 'state.json'))).mode & 0o777, 0o600);
  const receipts = await fsp.readdir(path.join(stateDirectory, 'receipts'));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(await fsp.readFile(path.join(stateDirectory, 'receipts', receipts[0])));
  assert.equal(receipt.preHash, 'MISSING');
  assert.match(receipt.postHash, /^[a-f0-9]{64}$/);
});

test('state lock rejects concurrent mutation and releases on failure', async t => {
  const stateDirectory = await directory(t);
  await withStateLock(stateDirectory, () => assert.rejects(withStateLock(stateDirectory, () => {}), /locked/));
  await assert.rejects(withStateLock(stateDirectory, () => { throw new Error('failure'); }), /failure/);
  await withStateLock(stateDirectory, () => {});
});

test('active locks report PID, hash and inode and are never removed', async t => {
  const stateDirectory = await directory(t);
  await ensurePrivateStateDir(stateDirectory);
  const lock = await writeLock(stateDirectory, { pid: process.pid, startedAt: '2026-11-02T00:00:00Z' });
  await assert.rejects(withStateLock(stateDirectory, () => {}), error => {
    assert.match(error.message, new RegExp(`owner PID ${process.pid} \\(active\\)`));
    assert.match(error.message, new RegExp(`lock SHA-256 ${lock.hash}, inode ${lock.inode}`));
    assert.match(error.message, /Do not remove the lock while that PID exists/);
    return true;
  });
  assert.equal((await fsp.stat(lock.lockPath)).ino, lock.inode);
});

test('stale lock recovery requires the exact reported hash and inode', async t => {
  const stateDirectory = await directory(t);
  await ensurePrivateStateDir(stateDirectory);
  const lock = await writeLock(stateDirectory, { pid: 99999999, startedAt: '2026-11-02T00:00:00Z' });
  await assert.rejects(recoverStateLock(stateDirectory, '0'.repeat(64), lock.inode), /Lock changed since its diagnostic/);
  await assert.rejects(recoverStateLock(stateDirectory, lock.hash, lock.inode + 1), /Lock changed since its diagnostic/);
  assert.equal((await fsp.stat(lock.lockPath)).ino, lock.inode);
  const result = await recoverStateLock(stateDirectory, lock.hash, lock.inode);
  assert.deepEqual(result, { recovered: true, lockPath: lock.lockPath, pid: 99999999, hash: lock.hash, inode: lock.inode });
  await assert.rejects(fsp.stat(lock.lockPath), { code: 'ENOENT' });
});

test('cleanup preserves unrelated files, refuses unowned hosts and keeps no local Gateway copy', async t => {
  const stateDirectory = await directory(t);
  await fsp.writeFile(path.join(stateDirectory, 'unrelated.txt'), 'preserve');
  await fsp.writeFile(path.join(stateDirectory, 'gateway-key'), 'fake');
  await removeStateArtifacts(stateDirectory);
  assert.equal(await fsp.readFile(path.join(stateDirectory, 'unrelated.txt'), 'utf8'), 'preserve');
  await assert.rejects(fsp.readFile(path.join(stateDirectory, 'gateway-key')), { code: 'ENOENT' });
  assert.throws(() => assertOwnedSandbox({ tags: {} }, state()), /not owned/);
});

test('remote diagnostics redact every resolved credential', async () => {
  const previousGateway = process.env.AI_GATEWAY_API_KEY;
  const previousVercel = process.env.VERCEL_TOKEN;
  process.env.AI_GATEWAY_API_KEY = 'gateway-secret';
  process.env.VERCEL_TOKEN = 'environment-secret';
  const resolved = { token: 'resolved-token', bridgeToken: 'bridge-secret', gatewayKey: 'gateway-secret' };
  const sandbox = { runCommand: async () => ({ exitCode: 17, stdout: async () => '', stderr: async () =>
    'gateway-secret environment-secret resolved-token bridge-secret' }) };
  try {
    await assert.rejects(runRemote(sandbox, 'Probe', {}, resolved), error => {
      assert.equal(error.message, 'Probe failed (exit 17): [redacted] [redacted] [redacted] [redacted]');
      return true;
    });
  } finally {
    if (previousGateway === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = previousGateway;
    if (previousVercel === undefined) delete process.env.VERCEL_TOKEN;
    else process.env.VERCEL_TOKEN = previousVercel;
  }
});

test('legacy numeric PID lock remains recoverable after its owner exits', async t => {
  const stateDirectory = await directory(t);
  await ensurePrivateStateDir(stateDirectory);
  const lockPath = path.join(stateDirectory, '.launcher.lock');
  await fsp.writeFile(lockPath, '99999999\n');
  const bytes = await fsp.readFile(lockPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const inode = (await fsp.stat(lockPath)).ino;
  const result = await recoverStateLock(stateDirectory, hash, inode);
  assert.equal(result.pid, 99999999);
  await withStateLock(stateDirectory, async () => {});
});

test('credential cleanup failure preserves launcher state for a safe retry', async t => {
  const stateDirectory = await directory(t);
  await ensurePrivateStateDir(stateDirectory);
  await writeStateAtomically(stateDirectory, state());
  await fsp.mkdir(path.join(stateDirectory, 'id_ed25519'));
  await assert.rejects(removeStateArtifacts(stateDirectory));
  assert.equal((await readState(stateDirectory)).name, state().name);
});
