import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
if (!args.includes('--output') || !args.includes('--node-archive') || !args.includes('--checksums')) throw new Error('Use --output DIR --node-archive node-v24.14.0-darwin-arm64.tar.gz --checksums SHASUMS256.txt');
const output = path.resolve(option('--output'));
const archive = path.resolve(option('--node-archive'));
const sums = await fs.readFile(path.resolve(option('--checksums')), 'utf8');
const archiveName = 'node-v24.14.0-darwin-arm64.tar.gz';
const expected = sums.split('\n').find(line => line.endsWith('  ' + archiveName))?.split(' ')[0];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (path.basename(archive) !== archiveName || !expected || hash(await fs.readFile(archive)) !== expected) throw new Error('Official Node archive checksum mismatch.');
await fs.mkdir(output, { recursive: true });
const resources = path.join(output, 'emdash-sandbox');
await fs.mkdir(resources);
const payload = path.join(resources, 'payload');
await fs.mkdir(path.join(payload, 'app'), { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'emdash-node-'));
const run = (cmd, argv) => { const r = spawnSync(cmd, argv, { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr || cmd + ' failed'); return r.stdout; };
try {
  run('/usr/bin/tar', ['-xzf', archive, '-C', temp]);
  const node = path.join(temp, 'node-v24.14.0-darwin-arm64');
  await fs.copyFile(path.join(node, 'bin/node'), path.join(payload, 'node'));
  await fs.chmod(path.join(payload, 'node'), 0o755);
  await fs.copyFile(path.join(node, 'LICENSE'), path.join(payload, 'NODE-LICENSE'));
} finally { await fs.rm(temp, { recursive: true, force: true }); }
for (const name of ['bin', 'src', 'package.json', 'README.md', 'LICENSE.md', 'licenses']) await fs.cp(path.join(root, name), path.join(payload, 'app', name), { recursive: true });
async function resolvePackage(from, name) {
  let at = from;
  for (;;) {
    const candidate = path.join(at, 'node_modules', name);
    try { return await fs.realpath(candidate); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(at); if (parent === at) return null; at = parent;
  }
}
async function copyDependencies(from, to, ancestors = new Set()) {
  const pkg = JSON.parse(await fs.readFile(path.join(from, 'package.json')));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).sort()) {
    const source = await resolvePackage(from, name);
    if (!source) { if (pkg.optionalDependencies?.[name]) continue; throw new Error('Missing dependency: ' + name); }
    if (ancestors.has(source)) continue;
    const dest = path.join(to, 'node_modules', name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(source, dest, { recursive: true, dereference: true, filter: p => !['node_modules', '.git', '.DS_Store'].includes(path.basename(p)) });
    await copyDependencies(source, dest, new Set([...ancestors, source]));
  }
}
await copyDependencies(root, path.join(payload, 'app'));
const files = [];
async function walk(dir, prefix = '') {
  for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const relative = prefix + e.name, file = path.join(dir, e.name);
    if (e.isDirectory()) await walk(file, relative + '/');
    else if (e.isFile()) files.push({ path: relative, sha256: hash(await fs.readFile(file)), executable: Boolean((await fs.stat(file)).mode & 0o111) });
    else throw new Error('Unexpected runtime link: ' + relative);
  }
}
await walk(payload);
await fs.writeFile(path.join(resources, 'runtime-manifest.json'), JSON.stringify({ schema: 1, nodeVersion: '24.14.0', architecture: 'arm64', files }, null, 2) + '\n');
for (const name of ['mac-install.mjs', 'cli-install.mjs']) await fs.copyFile(path.join(root, 'src', name), path.join(resources, name));
const releaseArchive = path.join(output, 'emdash-sandbox-darwin-arm64.tar.gz');
run('/usr/bin/tar', ['-czf', releaseArchive, '-C', output, 'emdash-sandbox']);
await fs.writeFile(path.join(output, 'SHA256SUMS'), hash(await fs.readFile(releaseArchive)) + '  ' + path.basename(releaseArchive) + '\n');
console.log(JSON.stringify({ archive: releaseArchive, files: files.length, node: '24.14.0', platform: 'darwin-arm64' }));
