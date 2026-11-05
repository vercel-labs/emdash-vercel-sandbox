import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const index = process.argv.indexOf('--archive');
if (index < 0 || !process.argv[index + 1]) throw new Error('Use --archive /path/to/emdash-sandbox-darwin-arm64.tar.gz');
const archive = path.resolve(process.argv[index + 1]);
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'emdash-cli-release-')));
const fixture = path.join(temp, 'download');
const bin = path.join(temp, 'bin');
const bootstrap = path.join(temp, 'bootstrap');
await fs.mkdir(fixture); await fs.mkdir(bin); await fs.mkdir(bootstrap);
await fs.copyFile(archive, path.join(fixture, path.basename(archive)));
await fs.copyFile(path.join(path.dirname(archive), 'SHA256SUMS'), path.join(fixture, 'SHA256SUMS'));
await fs.writeFile(path.join(bin, 'curl'), `#!/bin/sh
set -eu
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    https://github.com/vercel-labs/emdash-vercel-sandbox/releases/download/v0.1.0-preview.1/*) url=$1 ;;
    -o) shift; output=$1 ;;
  esac
  shift
done
[ -n "$url" ] && [ -n "$output" ]
printf '%s\\n' "$url" >> "$EMDASH_TEST_FETCHES"
cp "$EMDASH_TEST_DOWNLOADS/\${url##*/}" "$output"
`, { mode: 0o755 });
const environment = { ...process.env, TMPDIR: bootstrap, PATH: bin + ':/usr/bin:/bin', EMDASH_SANDBOX_RUNTIME_HOME: path.join(temp, 'runtimes'), EMDASH_SANDBOX_HOME: path.join(temp, 'state'), EMDASH_TEST_DOWNLOADS: fixture, EMDASH_TEST_FETCHES: path.join(temp, 'fetches') };
async function run(executable, args, env = environment) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, cwd: temp, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Installer probe timed out')); }, 60000);
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
let passed = false;
try {
  const first = await run('/bin/sh', [path.join(root, 'install.sh'), '--help']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /Quick start: emdash-sandbox setup/);
  assert.deepEqual(await fs.readdir(bootstrap), [], 'Successful install left bootstrap files behind');
  const versions = (await fs.readdir(environment.EMDASH_SANDBOX_RUNTIME_HOME)).filter(name => /^[a-f0-9]{64}$/.test(name));
  assert.equal(versions.length, 1);
  const installed = path.join(environment.EMDASH_SANDBOX_RUNTIME_HOME, versions[0]);
  const node = path.join(installed, 'node');
  const cli = path.join(installed, 'app/bin/emdash-sandbox.mjs');
  const afterCleanup = await run(node, [cli, '--help'], { ...environment, PATH: '/usr/bin:/bin' });
  assert.equal(afterCleanup.code, 0, afterCleanup.stderr);
  const retry = await run('/bin/sh', [path.join(root, 'install.sh'), '--help']);
  assert.equal(retry.code, 0, retry.stderr);
  assert.deepEqual(await fs.readdir(bootstrap), [], 'Repeated install left bootstrap files behind');
  assert.deepEqual((await fs.readdir(environment.EMDASH_SANDBOX_RUNTIME_HOME)).filter(name => /^[a-f0-9]{64}$/.test(name)), versions);
  const probe = `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    const base = ${JSON.stringify(path.join(installed, 'app/src'))};
    const { createSetupServer } = await import(pathToFileURL(base + '/setup-window-server.mjs'));
    const { createController } = await import(pathToFileURL(base + '/setup-window-controller.mjs'));
    const { hostBlock } = await import(pathToFileURL(base + '/ssh-config.mjs'));
    const { hostPaths } = await import(pathToFileURL(base + '/host-files.mjs'));
    const app = await createSetupServer({controller:createController({cached:()=>null,root:process.env.EMDASH_SANDBOX_HOME})});
    try {
      assert.equal((await fetch(app.origin)).status,200);
      for(const asset of ['/setup-window.css','/setup-window.mjs','/setup-presentation.mjs'])assert.equal((await fetch(app.origin+asset)).status,200);
      const state = await fetch(app.origin+'/api/state',{headers:{authorization:'Bearer '+app.capability}}).then(r=>r.json());
      assert.equal(state.phase,'signed-out'); assert.equal(state.hosts.length,0);
      const block=hostBlock(hostPaths('release-check'));
      assert.ok(block.includes(${JSON.stringify(installed)}));
      assert.ok(block.includes(${JSON.stringify(cli)}));
      console.log('INSTALLED_SETUP_HTTP_AND_STABLE_SSH_OK');
    } finally {await app.close();}
  `;
  const http = await run(node, ['--input-type=module', '-e', probe]);
  assert.equal(http.code, 0, http.stderr); assert.match(http.stdout, /INSTALLED_SETUP_HTTP_AND_STABLE_SSH_OK/);
  await fs.appendFile(path.join(fixture, path.basename(archive)), 'corruption');
  const corrupted = await run('/bin/sh', [path.join(root, 'install.sh'), '--help'], { ...environment, EMDASH_SANDBOX_RUNTIME_HOME: path.join(temp, 'corrupt-runtime') });
  assert.notEqual(corrupted.code, 0); assert.match(corrupted.stderr, /checksum mismatch/);
  assert.deepEqual(await fs.readdir(bootstrap), [], 'Rejected download left bootstrap files behind');
  await assert.rejects(fs.stat(path.join(temp, 'corrupt-runtime')), { code: 'ENOENT' });
  const beforeUnsupported = await fs.readFile(environment.EMDASH_TEST_FETCHES, 'utf8');
  await fs.writeFile(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
  const unsupported = await run('/bin/sh', [path.join(root, 'install.sh')]);
  assert.notEqual(unsupported.code, 0); assert.match(unsupported.stderr, /Apple Silicon Macs/);
  assert.equal(await fs.readFile(environment.EMDASH_TEST_FETCHES, 'utf8'), beforeUnsupported);
  passed = true;
  console.log('PASS: real CLI archive, shell installation, repeat installation, bootstrap cleanup, isolated signed-out HTTP/assets, stable SSH path, corruption rejection, unsupported-platform rejection. Download transport used a local fixture. Browser authorization and desktop E2E were not run.');
} finally {
  if (passed) await fs.rm(temp, { recursive: true, force: true });
  else console.error('Failure evidence retained at ' + temp);
}
