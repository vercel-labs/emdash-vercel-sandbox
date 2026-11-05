import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function verifyPayload(directory, manifest) {
  const rootStat = await fs.lstat(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(directory) !== path.resolve(directory)) throw new Error('Runtime payload must be a real canonical directory.');
  const seen = new Set();
  const actual = new Set();
  async function inventory(dir, prefix='') {
    for(const item of await fs.readdir(dir,{withFileTypes:true})) {
      const relative=prefix+item.name;
      if(item.isDirectory())await inventory(path.join(dir,item.name),relative+'/');
      else if(item.isFile())actual.add(relative);
      else throw new Error('Runtime links are not supported.');
    }
  }
  await inventory(directory);
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !/^[a-zA-Z0-9@_. /+-]+$/.test(item.path) || item.path.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(item.path) || seen.has(item.path)) throw new Error('Invalid runtime manifest.');
    seen.add(item.path);
    const file = path.join(directory, item.path);
    let current = directory;
    for (const part of item.path.split('/')) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Runtime links are not supported.');
    }
    const stat = await fs.lstat(file);
    if (!stat.isFile() || sha(await fs.readFile(file)) !== item.sha256 || Boolean(stat.mode & 0o111) !== item.executable) throw new Error('Runtime integrity check failed. Reinstall the helper.');
  }
  if (actual.size !== seen.size || [...actual].some(file => !seen.has(file))) throw new Error('Runtime integrity check failed: unexpected files.');
  for (const required of ['node', 'app/bin/emdash-sandbox.mjs']) if (!seen.has(required)) throw new Error('Runtime is incomplete.');
}

export async function installRuntime(resources, root = process.env.EMDASH_SANDBOX_RUNTIME_HOME ?? path.join(os.homedir(), 'Library/Application Support/Emdash Sandbox/runtimes')) {
  if (!path.isAbsolute(root)) throw new Error('Runtime directory must be absolute.');
  const bytes = await fs.readFile(path.join(resources, 'runtime-manifest.json'));
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 20000) throw new Error('Invalid runtime manifest.');
  const id = sha(bytes);
  const payload = path.join(resources, 'payload');
  await verifyPayload(payload, manifest);
  // Refuse symlinked installation ancestors before creating private runtime files.
  let directory = path.parse(root).root;
  for (const part of root.slice(directory.length).split(path.sep)) {
    directory = path.join(directory, part);
    await fs.mkdir(directory, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Runtime directory must not contain symbolic links.');
  }
  const rootStat = await fs.stat(root);
  if ((rootStat.mode & 0o077) || rootStat.uid !== process.getuid()) throw new Error('Runtime directory must be private and owned by you.');
  const destination = path.join(root, id);
  try {
    const stat = await fs.lstat(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe runtime installation.');
    await verifyPayload(destination, manifest);
    return destination;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(root, '.' + id + '-' + randomUUID());
  await fs.mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of await fs.readdir(payload)) await fs.cp(path.join(payload, entry), path.join(temporary, entry), { recursive: true, errorOnExist: true, force: false });
    await verifyPayload(temporary, manifest);
    try { await fs.rename(temporary, destination); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      const stat = await fs.lstat(destination);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe runtime installation.');
      await verifyPayload(destination, manifest);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return destination;
}

export async function launchInstalled(resources, args = ['setup']) {
  const installed = await installRuntime(resources);
  const child = spawn(path.join(installed, 'node'), [path.join(installed, 'app/bin/emdash-sandbox.mjs'), ...args], { stdio: 'inherit' });
  return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(new Error('Helper interrupted.')) : resolve(code)); });
}
