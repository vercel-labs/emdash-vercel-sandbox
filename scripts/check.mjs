import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else files.push(file);
  }
  return files;
}

const productFiles = await walk('src');
const javascript = ['bin/emdash-sandbox.mjs', ...productFiles, ...(await walk('scripts'))]
  .filter(file => file.endsWith('.mjs'));
const shell = ['install.sh', ...productFiles.filter(file => file.endsWith('.sh'))];
const python = productFiles.filter(file => file.endsWith('.py'));
const json = ['package.json', ...productFiles.filter(file => file.endsWith('.json'))];

for (const file of javascript) run(process.execPath, ['--check', file]);
for (const file of shell) run('bash', ['-n', file]);
for (const file of python) run('python3', ['-c', 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")', file]);
for (const file of json) {
  try { JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid JSON config ${file}: ${error.message}`); }
}

console.log(`Checked ${javascript.length} JavaScript modules, ${shell.length} shell scripts, ${python.length} Python files and ${json.length} JSON config files`);
