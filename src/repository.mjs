import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const limit = 32 * 1024 * 1024;
const fail = message => { throw new Error('Repository import: ' + message); };
async function git(repo, args) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  return exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    { env, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
}

export async function prepareRepository(input) {
  const repo = await fsp.realpath(path.resolve(input));
  const dotgit = await fsp.lstat(path.join(repo, '.git')).catch(() => null);
  if (!dotgit?.isDirectory() || dotgit.isSymbolicLink()) fail('select a conventional Git checkout root with its own .git directory');
  const read = async args => (await git(repo, args)).stdout.trim();
  if (await read(['rev-parse', '--show-toplevel']) !== repo) fail('select the checkout root');
  if (await read(['rev-parse', '--is-shallow-repository']) !== 'false') fail('shallow repositories are not supported');
  const config = await read(['config', '--local', '--list']);
  if (/^(extensions\.partialclone|remote\..*\.promisor|core\.sparsecheckout)=/im.test(config)) fail('partial or sparse repositories are not supported');
  const status = () => read(['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']);
  if (await status()) fail('commit or remove local changes and untracked files first; ignored files are not imported');
  let branch, head;
  try {
    branch = await read(['symbolic-ref', '--quiet', 'HEAD']);
    head = await read(['rev-parse', '--verify', 'HEAD^{commit}']);
  } catch { fail('check out a branch containing at least one commit'); }
  if (!branch.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(head)) fail('requires a committed SHA-1 branch');
  const tree = await read(['ls-tree', '-r', '-z', head]);
  if (tree.split('\0').some(entry => entry.startsWith('160000 ') || entry.endsWith('\t.gitmodules'))) fail('submodules are not supported');
  try {
    await git(repo, ['grep', '-q', '-I', '-F', '-e', 'version https://git-lfs.github.com/spec/v1', head, '--']);
    fail('Git LFS pointer files are not supported');
  } catch (error) { if (error.code !== 1) throw error; }
  const staging = await fsp.mkdtemp(path.join(os.tmpdir(), 'emdash-import-'));
  try {
    const file = path.join(staging, 'repository.bundle');
    await git(repo, ['bundle', 'create', file, branch]);
    await fsp.chmod(file, 0o600);
    if ((await fsp.stat(file)).size > limit) fail('selected branch bundle exceeds 32 MiB');
    const refs = await read(['bundle', 'list-heads', file]);
    if (refs !== `${head} ${branch}`) fail('branch changed while preparing import; retry with a stable checkout');
    await git(repo, ['bundle', 'verify', file]);
    if (await read(['rev-parse', 'HEAD']) !== head || await read(['symbolic-ref', 'HEAD']) !== branch || await status()) fail('checkout changed while preparing import; retry');
    const bundle = await fsp.readFile(file);
    return { branch: branch.slice('refs/heads/'.length), head,
      sha256: createHash('sha256').update(bundle).digest('hex'), bundle };
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}
