import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const helper = path.resolve('src/assets/bootstrap-project.py');

test('interruption after git init never publishes partial repository and retry succeeds', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'emdash-project-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, 'project'); await fs.mkdir(destination);
  const code = `import runpy,sys\nm=runpy.run_path(sys.argv[1])\ndef interrupt(staging):\n raise RuntimeError('simulated interruption after git init')\nm['prepare_project'](sys.argv[2],after_init=interrupt)`;
  await assert.rejects(exec('python3', ['-c', code, helper, destination]), /simulated interruption/);
  assert.deepEqual(await fs.readdir(destination), []);
  assert.ok((await fs.readdir(root)).some(x => x.startsWith('.emdash-project-setup-')));
  await exec('python3', [helper, destination]);
  assert.match((await exec('git', ['-C', destination, 'rev-parse', 'HEAD'])).stdout.trim(), /^[0-9a-f]{40}$/);
  const head = (await exec('git', ['-C', destination, 'rev-parse', 'HEAD'])).stdout;
  await fs.writeFile(path.join(destination, 'user-file'), 'preserve me');
  await exec('python3', [helper, destination]);
  assert.equal((await exec('git', ['-C', destination, 'rev-parse', 'HEAD'])).stdout, head);
  assert.equal(await fs.readFile(path.join(destination, 'user-file'), 'utf8'), 'preserve me');
});

test('clone failure retains staging, publishes no partial project, and a valid bundle retries successfully', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'emdash-clone-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'original'), destination = path.join(root, 'project'), bundle = path.join(root, 'source.bundle');
  await exec('python3', [helper, original]);
  const head = (await exec('git', ['-C', original, 'rev-parse', 'HEAD'])).stdout.trim();
  await exec('git', ['-C', original, 'bundle', 'create', bundle, 'main']);
  const code = `import runpy,sys,hashlib,subprocess\nm=runpy.run_path(sys.argv[1]); f=m['prepare_project']; original=f.__globals__['git']\ndef interrupted(*args):\n if args[0]=='clone':\n  original('init','--template=','-b','main',args[-1]);raise RuntimeError('simulated partial clone')\n return original(*args)\nf.__globals__['git']=interrupted\nbundle=sys.argv[3]; checksum=hashlib.sha256(open(bundle,'rb').read()).hexdigest()\nf(sys.argv[2],bundle,'main',sys.argv[4],checksum)`;
  await assert.rejects(exec('python3', ['-c', code, helper, destination, bundle, head]), /simulated partial clone/);
  await assert.rejects(fs.access(destination));
  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(await fs.readFile(bundle)).digest('hex');
  await exec('python3', [helper, destination, bundle, 'main', head, checksum]);
  assert.equal((await exec('git', ['-C', destination, 'rev-parse', 'HEAD'])).stdout.trim(), head);
});
