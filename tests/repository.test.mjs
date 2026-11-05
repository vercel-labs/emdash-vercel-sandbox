import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareRepository } from '../src/repository.mjs';

const exec = promisify(execFile);
async function git(repo, ...args) {
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args],
    {env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_OPTIONAL_LOCKS:'0'}})).stdout.trim();
}
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'emdash-repository-test-'));
  t.after(() => fsp.rm(root, {recursive:true,force:true}));
  const repo = path.join(root, 'source'); await fsp.mkdir(repo);
  await git(repo, 'init', '-b', 'feature/selected');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await fsp.writeFile(path.join(repo,'sum.mjs'), 'export const sum = (a,b) => a+b;\n');
  await fsp.writeFile(path.join(repo,'.gitignore'), 'ignored.txt\n');
  await git(repo, 'add', '.'); await git(repo,'commit','-m','Initial');
  return {root,repo};
}

test('selected committed branch and history round-trip without unrelated refs, ignored data or source mutation', async t => {
  const {root,repo} = await fixture(t);
  const initial = await git(repo,'rev-parse','HEAD');
  await git(repo,'checkout','-b','unrelated');
  await fsp.writeFile(path.join(repo,'unrelated.txt'),'not selected');
  await git(repo,'add','.'); await git(repo,'commit','-m','Unrelated');
  await git(repo,'checkout','feature/selected');
  await fsp.appendFile(path.join(repo,'sum.mjs'),'// selected history\n');
  await git(repo,'add','.'); await git(repo,'commit','-m','Second selected commit');
  await fsp.writeFile(path.join(repo,'ignored.txt'),'private ignored data');
  const before = await git(repo,'rev-parse','HEAD');
  const index = await fsp.readFile(path.join(repo,'.git/index'));
  const result = await prepareRepository(repo);
  assert.equal(result.branch,'feature/selected'); assert.equal(result.head,before);
  const bundle = path.join(root,'history.bundle'); await fsp.writeFile(bundle,result.bundle);
  const target = path.join(root,'restored');
  await git(root,'clone','--template=','-b',result.branch,bundle,target);
  assert.equal(await git(target,'rev-parse','HEAD'),before);
  assert.equal(await git(target,'rev-parse','HEAD^'),initial);
  assert.equal(await git(target,'rev-parse','HEAD^{tree}'),await git(repo,'rev-parse','HEAD^{tree}'));
  assert.equal(await git(target,'status','--porcelain=v1'),'');
  assert.equal(await git(repo,'rev-parse','HEAD'),before);
  assert.deepEqual(await fsp.readFile(path.join(repo,'.git/index')),index);
  assert.equal(await fsp.readFile(path.join(repo,'ignored.txt'),'utf8'),'private ignored data');
  await assert.rejects(fsp.access(path.join(target,'ignored.txt')));
  await assert.rejects(fsp.access(path.join(target,'unrelated.txt')));
  assert.equal((await git(target,'branch','-a')).includes('unrelated'),false);
});

test('dirty tracked, staged and untracked files are refused without modifying them', async t => {
  const {repo} = await fixture(t);
  await fsp.appendFile(path.join(repo,'sum.mjs'),'// local\n');
  await assert.rejects(prepareRepository(repo),/local changes/);
  await git(repo,'add','.'); await assert.rejects(prepareRepository(repo),/local changes/);
  await git(repo,'commit','-m','Save local');
  await fsp.writeFile(path.join(repo,'extra'),'untracked');
  await assert.rejects(prepareRepository(repo),/untracked/);
  assert.equal(await fsp.readFile(path.join(repo,'extra'),'utf8'),'untracked');
});

test('non-Git roots, detached HEAD and shallow checkouts fail admission', async t => {
  const {root,repo} = await fixture(t);
  await assert.rejects(prepareRepository(root),/checkout root/);
  const shallow = path.join(root,'shallow');
  await git(root,'clone','--depth=1','file://'+repo,shallow);
  await assert.rejects(prepareRepository(shallow),/shallow/);
  await git(repo,'checkout','--detach');
  await assert.rejects(prepareRepository(repo),/check out a branch/);
});

test('committed LFS pointers and submodules fail admission', async t => {
  const {repo} = await fixture(t);
  await fsp.writeFile(path.join(repo,'large.bin'),'version https://git-lfs.github.com/spec/v1\noid sha256:'+'a'.repeat(64)+'\nsize 42\n');
  await git(repo,'add','.'); await git(repo,'commit','-m','LFS pointer');
  await assert.rejects(prepareRepository(repo),/LFS/);
  await git(repo,'rm','large.bin'); await git(repo,'commit','-m','Remove pointer');
  const head=await git(repo,'rev-parse','HEAD');
  await git(repo,'update-index','--add','--cacheinfo',`160000,${head},nested`);
  await git(repo,'commit','-m','Submodule');
  await fsp.mkdir(path.join(repo,'nested'));
  await assert.rejects(prepareRepository(repo),/submodules/);
});
