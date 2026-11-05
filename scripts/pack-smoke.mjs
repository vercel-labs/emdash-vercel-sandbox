import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status ?? 'signal ' + result.signal}`);
  }
  return result;
}

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'emdash-pack-smoke-'));
const npmCache = path.join(temp, 'npm-cache');
const npmConfig = ['--cache', npmCache];
let tarball;
try {
  const packed = run('npm', ['pack', '--json', ...npmConfig]);
  const metadata = JSON.parse(packed.stdout);
  if (!Array.isArray(metadata) || metadata.length !== 1) throw new Error('npm pack did not return one package');
  tarball = path.join(root, metadata[0].filename);
  const listing = run('tar', ['-tzf', tarball]).stdout.split('\n');
  for (const required of ['package/bin/emdash-sandbox.mjs', 'package/src/cli.mjs', 'package/README.md', ...(await fsp.readdir(path.join(root, 'src/assets'))).map(name => 'package/src/assets/' + name)]) {
    if (!listing.includes(required)) throw new Error(`Tarball is missing ${required}`);
  }
  if (listing.some(name => name.includes('node_modules/') || name.includes('.pnpm-store/') || name.includes('package-lock.json'))) {
    throw new Error('Tarball contains dependencies, dependency cache or a generated lockfile');
  }

  const installDir = path.join(temp, 'installed');
  run('npm', ['install', '--prefix', installDir, ...npmConfig, '--registry=https://registry.npmjs.org',
    '--ignore-scripts', '--no-audit', '--no-fund', tarball]);
  const installedBin = path.join(installDir, 'node_modules', '.bin', 'emdash-sandbox');
  const help = run(installedBin, ['--help']);
  if (!help.stdout.includes('recover-lock')) throw new Error('Installed help does not document recover-lock');

  const invalid = spawnSync(installedBin, ['status', '--state-dir', 'relative-state'], { encoding: 'utf8', env: process.env });
  if (invalid.status === 0 || !invalid.stderr.includes('--state-dir must be an absolute path')) {
    throw new Error('Installed CLI did not reject a relative state directory');
  }
  console.log(`Pack smoke passed: ${metadata[0].filename}, ${listing.length} tar entries, fresh dependency install, installed help and invalid input`);
} finally {
  await fsp.rm(temp, { recursive: true, force: true });
  if (tarball) await fsp.rm(tarball, { force: true });
}
