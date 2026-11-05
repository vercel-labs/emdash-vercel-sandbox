import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { openSshCommandChannel } from './ssh-command.mjs';
import { assetPath } from './paths.mjs';
import { redactResolvedCredentials } from './credentials.mjs';
import { validateDestination } from './validate.mjs';

const execFileAsync = promisify(execFile);
const MiB = 1024 * 1024;
export const EXPORT_LIMITS = Object.freeze({ bundle: 32 * MiB, index: 4 * MiB,
  file: 8 * MiB, content: 32 * MiB, manifest: 100 * MiB, entries: 20000,
  history: 128 * MiB, objects: 100000 });
const oidPattern = /^[0-9a-f]{40}$/;
const foldPath = value => value.normalize('NFD').toLowerCase().replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g, '');
const fail = message => { throw new Error(`Invalid export: ${message}`); };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function safePath(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value) > 4096
      || value.split('/').some(p => !p || p === '.' || p === '..' || /[\0\\:]/.test(p)
        || /[ .]$/.test(p) || ['.git', 'git~1'].includes(foldPath(p)))) fail('unsafe relative path');
  return value;
}

export function validateExportSelection(value = '/home/emdash/project') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\0')
      || value.includes('\\') || path.posix.normalize(value) !== value || value.endsWith('/')
      || !['/home/emdash/project', '/home/emdash/emdash/worktrees'].some(root => value === root || value.startsWith(root + '/'))
      || value.split('/').some(part => ['.git', 'git~1'].includes(foldPath(part)))) {
    fail('select an exact absolute worktree under /home/emdash/project or /home/emdash/emdash/worktrees');
  }
  return value;
}

function decode(value, limit, label) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(limit / 3)
      || value.length % 4 !== 0) fail(`${label} base64 or size`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > limit || bytes.toString('base64') !== value) fail(`${label} base64 or size`);
  return bytes;
}

function validateRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('refs/') || ref.length > 4096
      || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{')
      || ref.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))) fail('unsafe Git ref');
  return ref;
}

export function validateExportManifest(text, expectedSelection) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > EXPORT_LIMITS.manifest) fail('manifest exceeds 100 MiB');
  const m = JSON.parse(text);
  if (!m || m.version !== 1 || typeof m.selection !== 'string' || (expectedSelection !== undefined && m.selection !== expectedSelection)
      || !oidPattern.test(m.head) || (m.branch !== null && (!validateRef(m.branch) || !m.branch.startsWith('refs/heads/')))
      || !Array.isArray(m.entries) || m.entries.length > EXPORT_LIMITS.entries
      || !Array.isArray(m.indexBlobs) || m.indexBlobs.length > EXPORT_LIMITS.entries) fail('manifest metadata');
  const bundle = decode(m.bundle, EXPORT_LIMITS.bundle, 'bundle');
  const index = m.index === null ? null : decode(m.index, EXPORT_LIMITS.index, 'index');
  let total = 0;
  const blobs = new Map();
  for (const item of m.indexBlobs) {
    if (!item || !oidPattern.test(item.oid) || blobs.has(item.oid)) fail('index blob identity');
    const data = decode(item.data, EXPORT_LIMITS.file, 'index blob');
    total += data.length;
    blobs.set(item.oid, data);
  }
  const names = new Map();
  const entries = [];
  for (const item of m.entries) {
    if (!item) fail('file entry');
    const name = safePath(item.path);
    if (names.has(name)) fail('duplicate file path');
    names.set(name, item);
    if (item.type === 'file') {
      if (![0o644, 0o755].includes(item.mode)) fail('file mode');
      const data = decode(item.data, EXPORT_LIMITS.file, 'file');
      total += data.length;
      entries.push({ ...item, data });
    } else if (item.type === 'symlink') {
      if (typeof item.target !== 'string' || !item.target || !item.target.isWellFormed() || Buffer.byteLength(item.target) > 4096
          || item.target.startsWith('/') || /[\0\\:]/.test(item.target)
          || item.target.split('/').some(p => ['.git', 'git~1'].includes(foldPath(p)))) fail('unsafe symlink target');
      total += Buffer.byteLength(item.target);
      entries.push(item);
    } else fail('unsupported file type');
  }
  if (total > EXPORT_LIMITS.content) fail('index and working content exceed 32 MiB');
  validatePaths(entries);
  const resolveLink = (name, target) => {
    const pending = [...path.posix.dirname(name).split('/').filter(p => p !== '.'), ...target.split('/')];
    const resolved = [];
    let hops = 0;
    while (pending.length) {
      const part = pending.shift();
      if (!part || part === '.') continue;
      if (part === '..') { if (!resolved.length) fail('symlink escapes export root'); resolved.pop(); continue; }
      safePath(part);
      resolved.push(part);
      const entry = names.get(resolved.join('/'));
      if (entry?.type === 'symlink') {
        if (++hops > 40) fail('symlink cycle or excessive depth');
        resolved.pop(); pending.unshift(...entry.target.split('/'));
      }
    }
  };
  for (const entry of entries) if (entry.type === 'symlink') resolveLink(entry.path, entry.target);
  return { ...m, bundle, index, blobs, entries };
}

function validatePaths(entries, indexedPaths = []) {
  const names = new Set(entries.map(entry => entry.path));
  const spellings = new Map();
  for (const name of [...names.keys(), ...indexedPaths]) {
    const parts = safePath(name).split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const key = foldPath(prefix);
      if (spellings.has(key) && spellings.get(key) !== prefix) fail('case or Unicode path collision');
      spellings.set(key, prefix);
      if (i < parts.length && names.has(prefix) && names.has(name)) fail('file or symlink used as directory');
    }
  }
}

function gitEnv() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
}

async function git(repo, args, options = {}) {
  return execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], {
    env: gitEnv(), encoding: 'utf8', timeout: 120000, maxBuffer: 8 * MiB, ...options });
}

export async function publishExport(source, destination) {
  try {
    await execFileAsync('python3', ['-I', assetPath('publish-export.py'), source, destination], {timeout:120000, maxBuffer:8192});
  } catch (error) {
    let diagnostic;
    try { diagnostic = JSON.parse(error.stderr); } catch {}
    throw Object.assign(new Error('Atomic export publication failed: ' + (diagnostic?.message || error.message) +
      '. Python 3 and a filesystem supporting exclusive rename are required.'), {code:diagnostic?.code || error.code});
  }
}

export async function restoreExportManifest(text, requestedDestination, { stateDir = os.tmpdir(), expectedSelection, publish = publishExport } = {}) {
  const destination = validateDestination(requestedDestination, stateDir);
  const m = validateExportManifest(text, expectedSelection);
  try { await fsp.lstat(destination); throw new Error('Export destination already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const parent = path.dirname(destination);
  const realParent = await fsp.realpath(parent);
  if (realParent !== parent) throw new Error('Export parent must be an existing canonical directory without symlinks');
  const canonicalState = await fsp.realpath(stateDir).catch(() => path.resolve(stateDir));
  if (destination === canonicalState || destination.startsWith(canonicalState + path.sep)) throw new Error('Export destination cannot be inside private state');
  const staging = await fsp.mkdtemp(path.join(parent, '.emdash-export-'));
  try {
    const repo = path.join(staging, 'repo');
    const bundlePath = path.join(staging, 'history.bundle');
    await fsp.mkdir(repo, { mode: 0o700 });
    await fsp.writeFile(bundlePath, m.bundle, { mode: 0o600, flag: 'wx' });
    await git(repo, ['init', '--template=', '--object-format=sha1', '.']);
    await git(repo, ['config', 'core.fileMode', 'true']);
    await git(repo, ['config', 'core.symlinks', 'true']);
    await git(repo, ['config', 'core.logAllRefUpdates', 'false']);
    await git(repo, ['bundle', 'verify', bundlePath]);
    const { stdout: heads } = await git(repo, ['bundle', 'list-heads', bundlePath]);
    const refs = new Map();
    const foldedRefs = new Set();
    for (const line of heads.trimEnd().split('\n')) {
      const oid = line.slice(0, 40), ref = line.slice(41);
      if (!oidPattern.test(oid) || line[40] !== ' ' || (ref !== 'HEAD' && !validateRef(ref))) fail('bundle ref');
      if (foldedRefs.has(foldPath(ref))) fail('duplicate or colliding Git ref');
      foldedRefs.add(foldPath(ref));
      refs.set(ref, oid);
    }
    if (refs.get('HEAD') !== m.head || (m.branch !== null && refs.get(m.branch) !== m.head)) fail('HEAD and branch disagree with bundle');
    await git(repo, ['bundle', 'unbundle', bundlePath]);
    const { stdout: sizes } = await git(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectsize)']);
    const objectSizes = sizes.trim().split('\n').map(Number);
    if (objectSizes.length > EXPORT_LIMITS.objects || objectSizes.some(size => !Number.isSafeInteger(size) || size < 0)
        || objectSizes.reduce((sum, size) => sum + size, 0) > EXPORT_LIMITS.history) fail('expanded history exceeds limits');
    for (const [ref, oid] of refs) if (ref !== 'HEAD') await git(repo, ['update-ref', ref, oid]);
    await git(repo, ['cat-file', '-e', `${m.head}^{commit}`]);
    if (m.branch) await git(repo, ['symbolic-ref', 'HEAD', m.branch]);
    else await git(repo, ['update-ref', '--no-deref', 'HEAD', m.head]);
    const blobPath = path.join(staging, 'index-blob');
    for (const [oid, data] of m.blobs) {
      await fsp.writeFile(blobPath, data, { mode: 0o600 });
      const { stdout } = await git(repo, ['hash-object', '-w', '--no-filters', blobPath]);
      if (stdout.trim() !== oid) fail('restored staged blob hash');
    }
    if (m.index !== null) await fsp.writeFile(path.join(repo, '.git', 'index'), m.index, { mode: 0o600, flag: 'wx' });
    if ((await git(repo, ['rev-parse', '--shared-index-path'])).stdout.trim()) fail('split index unsupported');
    const { stdout: indexListing } = await git(repo, ['ls-files', '--stage', '-z'], { encoding: 'buffer' });
    const records = new TextDecoder('utf-8', { fatal: true }).decode(indexListing).split('\0').filter(Boolean);
    if (records.length > EXPORT_LIMITS.entries) fail('index entry count');
    const indexedPaths = records.map(record => {
      const tab = record.indexOf('\t');
      const metadata = /^(100644|100755|120000) ([0-9a-f]{40}) [0-3]$/.exec(record.slice(0, tab));
      if (tab < 0 || !metadata) fail('unsupported index mode or submodule');
      if (!m.blobs.has(metadata[2])) fail('missing staged blob');
      return safePath(record.slice(tab + 1));
    });
    validatePaths(m.entries, indexedPaths);
    await git(repo, ['fsck', '--full', '--no-reflogs']);
    // No checkout runs: absent files preserve deletions, and Git filters cannot execute.
    for (const entry of m.entries) {
      const target = path.join(repo, entry.path);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      if (entry.type === 'symlink') await fsp.symlink(entry.target, target);
      else {
        await fsp.writeFile(target, entry.data, { flag: 'wx', mode: entry.mode });
        await fsp.chmod(target, entry.mode);
      }
    }
    const { stdout: gitStatus } = await git(repo, ['status', '--porcelain=v1', '--untracked-files=all']);
    await publish(repo, destination);
    return { destination, worktree: m.selection, worktreeName: m.selection, head: m.head, branch: m.branch, gitStatus };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

export function buildExportCommand(helper, selection) {
  return `python3 -c ${quote(helper)} ${quote(validateExportSelection(selection))}`;
}

export async function exportProject(options, openChannel = openSshCommandChannel) {
  const { state, stateDir, destination } = options;
  validateDestination(destination, stateDir);
  const selection = validateExportSelection(options.worktreePath ?? options.worktree ?? options.worktreeName);
  const helper = await fsp.readFile(assetPath('export-project.py'), 'utf8');
  const connection = await openChannel({ bridgeUrl: state.url, bridgeToken: state.bridgeToken,
    hostPublicKey: state.hostPublicKey, privateKey: options.privateKey });
  let response;
  try {
    response = await connection.exec(buildExportCommand(helper, selection), 120000);
  } catch (error) {
    const diagnostic = redactResolvedCredentials(error.stderr || error.message || String(error), {
      token: options.credentials?.token, bridgeToken: state.bridgeToken,
    }).slice(-8000);
    throw new Error('Remote Git export failed: ' + diagnostic);
  } finally { connection.close(); }
  return restoreExportManifest(response.stdout, destination, { stateDir, expectedSelection: selection });
}
