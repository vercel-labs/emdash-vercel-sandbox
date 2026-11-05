import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { ensurePrivateStateDir, withStateLock } from './state.mjs';

export const digest = bytes => bytes === null ? 'MISSING' : createHash('sha256').update(bytes).digest('hex');
export function hostPaths(name, root = process.env.EMDASH_SANDBOX_HOME ?? path.join(os.homedir(), '.local/state/emdash-sandbox')) {
  if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name)) {
    throw new Error('Host name must be 1–40 lowercase letters, digits or hyphens, starting and ending with a letter or digit');
  }
  if (!path.isAbsolute(root)) throw new Error('EMDASH_SANDBOX_HOME must be an absolute path');
  const directory = path.join(root, 'hosts', name);
  return { name, alias: `vercel-${name}`, directory, stateDir: path.join(directory, 'state'), connection: path.join(directory, 'connection.json') };
}

export async function readRegular(file, { privateFile = false, missing = false } = {}) {
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024 || (privateFile && (stat.mode & 0o077))) throw new Error('Unsafe file: ' + path.basename(file));
    return await handle.readFile();
  } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

export async function replaceFile(file, content, expectedHash, receiptDir) {
  const before = await readRegular(file, { missing: true });
  if (digest(before) !== expectedHash) throw new Error('STALE_PRECONDITION: ' + path.basename(file));
  const lock = await fs.open(file + '.edit-lock', 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another operation is editing ' + path.basename(file) + '; retry after it finishes');
    throw error;
  });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    if (digest(await readRegular(file, { missing: true })) !== expectedHash) throw new Error('STALE_PRECONDITION: ' + path.basename(file));
    const out = await fs.open(temporary, 'wx', 0o600);
    try { await out.writeFile(content); await out.sync(); } finally { await out.close(); }
    if (digest(await readRegular(file, { missing: true })) !== expectedHash) throw new Error('STALE_PRECONDITION: ' + path.basename(file));
    await fs.rename(temporary, file);
    const receipt = { target: file, preHash: expectedHash, postHash: digest(Buffer.from(content)), at: new Date().toISOString(), result: 'WRITE_COMMITTED' };
    await fs.writeFile(path.join(receiptDir, randomUUID() + '.json'), JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 });
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await lock.close(); await fs.unlink(file + '.edit-lock');
  }
}

export async function withConnectionLock(paths, action) {
  const dir = await ensurePrivateStateDir(path.join(paths.directory, 'auth-lock'));
  return withStateLock(dir, action);
}

export async function writeConnection(paths, value, expectedHash) {
  await ensurePrivateStateDir(paths.directory);
  await replaceFile(paths.connection, JSON.stringify(value) + '\n', expectedHash, path.join(paths.directory, 'receipts'));
}
