import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { StateError, UsageError } from './errors.mjs';
import { validateStateObject } from './validate.mjs';

const STATE_FILE = 'state.json';
const LOCK_FILE = '.launcher.lock';
const RECEIPTS_DIR = 'receipts';

async function fileHash(file) {
  try {
    return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return 'MISSING';
    throw error;
  }
}

export function statePath(stateDir) {
  return path.join(stateDir, STATE_FILE);
}

export async function ensurePrivateStateDir(stateDir) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new UsageError('--state-dir must be an absolute path');
  }
  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stats = await fsp.lstat(stateDir);
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0) {
    throw new StateError('State directory must be private (mode 0700)');
  }
  await fsp.mkdir(path.join(stateDir, RECEIPTS_DIR), { recursive: true, mode: 0o700 });
  return path.resolve(stateDir);
}

function parseLockOwner(bytes) {
  const text = bytes.toString('utf8').trim();
  let pid;
  try {
    const parsed = JSON.parse(text);
    pid = typeof parsed === 'number' ? parsed : parsed?.pid;
  } catch {
    pid = Number(text);
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid: null, valid: false };
  return { pid, valid: true };
}

async function readLock(lockPath) {
  const handle = await fsp.open(lockPath, 'r');
  try {
    const bytes = await handle.readFile();
    const stats = await handle.stat();
    return { bytes, hash: createHash('sha256').update(bytes).digest('hex'), inode: stats.ino };
  } finally {
    await handle.close();
  }
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

export async function withStateLock(stateDir, operation) {
  const dir = await ensurePrivateStateDir(stateDir);
  const lockPath = path.join(dir, LOCK_FILE);
  let lock;
  try {
    lock = await fsp.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try {
      const current = await readLock(lockPath);
      const owner = parseLockOwner(current.bytes);
      const state = !owner.valid ? 'invalid' : pidExists(owner.pid) ? 'active' : 'stale';
      throw new StateError(
        `State directory is locked by owner PID ${owner.pid ?? 'unknown'} (${state}); lock SHA-256 ${current.hash}, inode ${current.inode}. ` +
        (state === 'stale'
          ? `Recover it explicitly with: emdash-sandbox recover-lock --state-dir ${dir} --lock-hash ${current.hash} --lock-inode ${current.inode}`
          : 'Do not remove the lock while that PID exists.'));
    } catch (diagnosticError) {
      if (diagnosticError instanceof StateError) throw diagnosticError;
      throw new StateError('State directory is locked, but the existing lock could not be inspected; do not remove it automatically');
    }
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await lock.close();
    await fsp.unlink(lockPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  };
  try {
    const owner = { pid: process.pid, startedAt: new Date().toISOString() };
    await lock.write(JSON.stringify(owner) + '\n');
    return await operation();
  } finally {
    await release().catch(() => {});
  }
}

export async function recoverStateLock(stateDir, expectedHash, expectedInode) {
  const dir = await ensurePrivateStateDir(stateDir);
  const lockPath = path.join(dir, LOCK_FILE);
  if (!/^[0-9a-f]{64}$/.test(expectedHash ?? '')) throw new UsageError('--lock-hash must be the SHA-256 reported by the lock error');
  if (!/^[1-9][0-9]*$/.test(String(expectedInode ?? '')) || !Number.isSafeInteger(Number(expectedInode))) {
    throw new UsageError('--lock-inode must be the inode reported by the lock error');
  }
  const inode = Number(expectedInode);
  const current = await readLock(lockPath);
  const owner = parseLockOwner(current.bytes);
  if (current.hash !== expectedHash || current.inode !== inode) {
    throw new StateError('Lock changed since its diagnostic; rerun the blocked command and use the new lock hash and inode');
  }
  if (!owner.valid) throw new StateError('Lock has an invalid owner record; investigate it before recovery');
  if (pidExists(owner.pid)) throw new StateError(`Lock owner PID ${owner.pid} is still present; do not recover this lock`);
  const checked = await readLock(lockPath);
  if (checked.hash !== current.hash || checked.inode !== current.inode) {
    throw new StateError('Lock changed during recovery; rerun the blocked command and use the new lock hash and inode');
  }
  await fsp.unlink(lockPath);
  return { recovered: true, lockPath, pid: owner.pid, hash: current.hash, inode: current.inode };
}

export async function readState(stateDir) {
  const file = statePath(stateDir);
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new StateError('No launcher state found; run create first');
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateError('Launcher state is not valid JSON');
  }
  return validateStateObject(parsed);
}

export async function writeStateAtomically(stateDir, nextState) {
  const validated = validateStateObject(nextState);
  const dir = await ensurePrivateStateDir(stateDir);
  const target = statePath(dir);
  const preHash = await fileHash(target);
  const temporary = path.join(dir, `.state-${randomUUID()}.tmp`);
  const content = JSON.stringify(validated, null, 2) + '\n';
  const handle = await fsp.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const currentHash = await fileHash(target);
  if (currentHash !== preHash) {
    await fsp.unlink(temporary).catch(() => {});
    throw new StateError('STALE_PRECONDITION: state changed during write');
  }
  await fsp.rename(temporary, target);
  const postHash = await fileHash(target);
  const receipt = {
    id: randomUUID(),
    target,
    operation: 'write-state',
    preHash,
    postHash,
    at: new Date().toISOString(),
    result: 'WRITE_COMMITTED'
  };
  const receiptPath = path.join(dir, RECEIPTS_DIR, `${receipt.id}.json`);
  await fsp.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return validated;
}

export async function writePrivateFile(file, content, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (await fileHash(file) !== 'MISSING') {
    throw new StateError(`Refusing to overwrite existing private file: ${path.basename(file)}`);
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fsp.open(temporary, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(temporary, file);
}

export async function removeStateArtifacts(stateDir) {
  const dir = path.resolve(stateDir);
  for (const name of ['id_ed25519','id_ed25519.pub','bridge-token','gateway-key','repository.bundle','state.json']) {
    await fsp.unlink(path.join(dir,name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function readFileSyncPrivate(file) {
  const stats = fs.statSync(file);
  if ((stats.mode & 0o077) !== 0) throw new StateError(`Private file has unsafe permissions: ${path.basename(file)}`);
  return fs.readFileSync(file);
}
