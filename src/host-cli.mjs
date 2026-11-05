import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { hostPaths, readRegular, digest, writeConnection, withConnectionLock } from './host-files.mjs';
import { deviceLogin, hostCredentials, selectSetupScope, validateScope, parseConnection } from './connection.mjs';
import { resolveCredentials } from './credentials.mjs';
import { ensurePrivateStateDir, readState, readFileSyncPrivate, withStateLock } from './state.mjs';
import { generateClientKeyPair } from './keys.mjs';
import { createSandbox, continueCreateSandbox, resumeSandbox, stopSandbox, statusSandbox } from './lifecycle.mjs';
import { registerHost, hostBlock } from './ssh-config.mjs';
import { runStdioProxy } from './proxy.mjs';
import { listTasks } from './tasks.mjs';
import { exportProject, validateExportSelection } from './export.mjs';

export const hostHelp = `Quick start: emdash-sandbox setup
  Open a setup window. Sign in, search projects, create or start/stop a host.
  Then select vercel-NAME in EmDash's SSH config picker. Close this terminal.

emdash-sandbox setup --terminal [--name NAME] [--repo /path/to/repo] [--timeout-minutes 45]
emdash-sandbox hosts
emdash-sandbox <start|stop|status|tasks|login|register> --host NAME
emdash-sandbox export --host NAME --destination ./retrieved-task [--worktree /remote/task]

start explicitly starts/resumes compute. stop saves files. export lists tasks to choose.
setup/register: --ssh-config /path/to/config overrides ~/.ssh/config.
Automation: setup --name NAME --use-cli --project-config /path/.vercel/project.json --yes
`;

const spec = {
  setup: ['name', 'repo', 'timeout-minutes', 'ssh-config', 'use-cli', 'project-config', 'yes'],
  hosts: [], proxy: ['state-dir'], start: ['host'], stop: ['host'], status: ['host'], tasks: ['host'],
  login: ['host'], register: ['host', 'ssh-config'], export: ['host', 'destination', 'worktree'],
};
const switches = new Set(['use-cli', 'yes']);
export function parseHostArgs(argv) {
  const [command, ...rest] = argv, flags = {};
  if (!spec[command]) throw new Error('Unknown host command');
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!spec[command].includes(key) || key in flags) throw new Error('Invalid or duplicate option: ' + rest[i]);
    if (switches.has(key)) flags[key] = true;
    else {
      if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('Missing value for --' + key);
      flags[key] = rest[++i];
    }
  }
  if (!['setup', 'hosts', 'proxy'].includes(command) && !flags.host) throw new Error('--host is required');
  if (flags.host) hostPaths(flags.host);
  if (flags.name) hostPaths(flags.name);
  if (command === 'proxy' && !path.isAbsolute(flags['state-dir'] ?? '')) throw new Error('proxy requires an absolute --state-dir');
  if (command === 'setup' && flags['project-config'] && !flags['use-cli']) throw new Error('--project-config requires --use-cli');
  if (command === 'setup' && flags['use-cli'] && !path.isAbsolute(flags['project-config'] ?? '')) throw new Error('--use-cli requires an absolute --project-config');
  if (flags['timeout-minutes'] && (!Number.isInteger(Number(flags['timeout-minutes'])) || Number(flags['timeout-minutes']) < 5 || Number(flags['timeout-minutes']) > 90)) throw new Error('Timeout must be 5–90 minutes');
  if (command === 'export' && !flags.destination) throw new Error('--destination is required');
  if (flags.worktree) validateExportSelection(flags.worktree);
  if (flags['ssh-config'] && !path.isAbsolute(flags['ssh-config'])) throw new Error('--ssh-config must be absolute');
  return { command, flags };
}

const clean = value => String(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '');
function terminal() {
  let rl;
  return {
    async ask(question) {
      if (!process.stdin.isTTY) throw new Error('This step needs an interactive terminal. For automation, use explicit options shown in --help.');
      rl ??= createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(question);
      return answer.trim();
    },
    close() { rl?.close(); },
  };
}
export async function choose(items, label, ui) {
  if (!items.length) throw new Error('No ' + label.toLowerCase() + ' available for this Vercel connection');
  items.forEach((item, i) => process.stderr.write(`${i + 1}. ${clean(item.name)}\n`));
  const answer = await ui.ask(label + ' number: ');
  const index = Number(answer) - 1;
  if (!/^\d+$/.test(answer) || !Number.isInteger(index) || index < 0 || index >= items.length) throw new Error('Choose one of the listed numbers and retry.');
  return items[index];
}
function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { stdio: 'ignore', detached: true });
  child.on('error', () => {}); child.unref();
}
async function browserLogin() {
  return deviceLogin({ show: ({ url, code }) => {
    process.stderr.write(`Approve Vercel sign-in in your browser. Code: ${clean(code)}\n${url}\n`);
    openBrowser(url);
  } });
}
function success(paths) {
  process.stdout.write(`Host ready: ${paths.alias}\nIn EmDash: Settings > Machines > Add SSH Connection > SSH config.\nSelect ${paths.alias}, save, and connect. Add /home/emdash/project as a remote project.\nCreate a Codex task and sign into Codex when asked. You can close this terminal.\nStop compute: emdash-sandbox stop --host ${paths.name}\n`);
}
function registrationSuccess(paths) {
  process.stdout.write(`Host registered: ${paths.alias}.\nCheck the host: emdash-sandbox status --host ${paths.name}\nIf stopped, start it: emdash-sandbox start --host ${paths.name}\nThen select ${paths.alias} in EmDash's SSH config picker.\n`);
}
const optionsFor = (state, stateDir) => ({ bridgeUrl: state.url, bridgeToken: state.bridgeToken, hostPublicKey: state.hostPublicKey, privateKey: readFileSyncPrivate(path.join(stateDir, 'id_ed25519')) });

export async function setupHost(flags, ui, { preparedConnection } = {}) {
  const name = flags.name ?? await ui.ask('Host name (for example my-project): ');
  const paths = hostPaths(name);
  hostBlock(paths);
  await ensurePrivateStateDir(paths.directory);
  return withStateLock(paths.directory, async () => {
    if (preparedConnection) {
      const existing = await readRegular(paths.connection, { privateFile: true, missing: true });
      if (existing) { const saved = parseConnection(existing); if (saved.teamId !== preparedConnection.teamId || saved.projectId !== preparedConnection.projectId) throw new Error('A host with this name belongs to another project. Choose a different host name.'); }
    }
    const savedState = await readRegular(path.join(paths.stateDir, 'state.json'), { privateFile: true, missing: true });
    if (savedState) {
      let state = await readState(paths.stateDir);
      if (['preparing', 'allocating', 'provisioning'].includes(state.setupPhase)) {
        if (!flags.yes && !/^y(es)?$/i.test(await ui.ask('Continue setup of this host? This can start compute. [y/N]: '))) return;
        const credentials = await hostCredentials(paths);
        await withStateLock(paths.stateDir, () => continueCreateSandbox(paths.stateDir, state, credentials, { hostName: name }));
        state = await readState(paths.stateDir);
      }
      if (!state.hostPublicKey) throw new Error(`Setup was interrupted. Check: emdash-sandbox status --host ${name}. The original host is retained; setup will not create another.`);
      await registerHost(paths, state, { configFile: flags['ssh-config'] });
      registrationSuccess(paths);
      return;
    }
    let saved = await readRegular(paths.connection, { privateFile: true, missing: true });
    if (!saved) {
      let connection;
      if (preparedConnection) {
        connection = preparedConnection;
      } else if (flags['use-cli']) {
        const credentials = await resolveCredentials({ projectConfig: flags['project-config'], ignoreEnvironment: true });
        const scope = await validateScope(credentials.token, credentials.teamId, credentials.projectId);
        connection = { type: 'cli', projectConfig: flags['project-config'], ...scope };
      } else {
        connection = await browserLogin();
        try { await selectSetupScope(connection, (items, label) => choose(items, label, ui)); }
        catch (error) { throw new Error(error.message + `\nNo host was created. Retry with: emdash-sandbox setup --name ${name}`); }
      }
      await withConnectionLock(paths, () => writeConnection(paths, connection, 'MISSING'));
      saved = Buffer.from(JSON.stringify(connection));
    }
    const scope = parseConnection(saved);
    const timeoutMinutes = Number(flags['timeout-minutes'] ?? 45);
    process.stderr.write(`Create ${paths.alias} in ${clean(scope.teamName ?? scope.teamId)} / ${clean(scope.projectName ?? scope.projectId)}?\nSession: ${timeoutMinutes} minutes. Vercel Sandbox compute and snapshot charges apply.\n`);
    if (!flags.yes && !/^y(es)?$/i.test(await ui.ask('Create host? [y/N]: '))) {
      process.stdout.write('Setup saved. No Sandbox was created. Run setup again when ready.\n'); return;
    }
    const credentials = await hostCredentials(paths);
    await ensurePrivateStateDir(paths.stateDir);
    process.stderr.write('Creating your host and preparing EmDash. This may take a few minutes…\n');
    const keyPair = await generateClientKeyPair();
    await withStateLock(paths.stateDir, () => createSandbox({ stateDir: paths.stateDir, credentials,
      name: 'emdash-' + name + '-' + randomBytes(4).toString('hex'), timeoutMinutes, relayPort: 22222,
      keyPair, repositoryPath: flags.repo, hostName: name }));
    await registerHost(paths, await readState(paths.stateDir), { configFile: flags['ssh-config'] });
    success(paths);
  });
}

export async function runHostCli(argv) {
  const { command, flags } = parseHostArgs(argv);
  const ui = terminal();
  try {
    if (command === 'setup') return await setupHost(flags, ui);
    if (command === 'hosts') {
      const root = path.dirname(hostPaths('placeholder').directory);
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const entry of entries.filter(x => x.isDirectory() && /^[a-z0-9-]+$/.test(x.name))) {
        const p = hostPaths(entry.name);
        process.stdout.write(`${p.name}\t${p.alias}\n`);
      }
      return;
    }
    if (command === 'proxy') {
      const state = await readState(flags['state-dir']);
      if (state.status !== 'running') throw new Error('Host is stopped or needs recovery. Run emdash-sandbox start --host NAME before reconnecting.');
      return await runStdioProxy(optionsFor(state, flags['state-dir']));
    }
    const paths = hostPaths(flags.host);
    if (command === 'login') {
      await withConnectionLock(paths, async () => {
        const raw = await readRegular(paths.connection, { privateFile: true });
        const before = parseConnection(raw), fresh = await browserLogin();
        await validateScope(fresh.token, before.teamId, before.projectId);
        await writeConnection(paths, { ...before, ...fresh }, digest(raw));
      });
      process.stdout.write('Vercel sign-in renewed for ' + paths.name + '.\n'); return;
    }
    const state = await readState(paths.stateDir);
    if (command === 'register') {
      await registerHost(paths, state, { configFile: flags['ssh-config'] });
      registrationSuccess(paths);
      return;
    }
    if (command === 'export') {
      if (await fs.lstat(path.resolve(flags.destination)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Export destination already exists; choose a new directory.');
    }
    const credentials = await hostCredentials(paths);
    if (state.teamId !== credentials.teamId || state.projectId !== credentials.projectId) throw new Error('Saved connection does not match this host');
    if (['start', 'stop'].includes(command)) {
      const result = await withStateLock(paths.stateDir, async () => {
        const latest = await readState(paths.stateDir);
        return ({ start: resumeSandbox, stop: stopSandbox })[command](paths.stateDir, latest, credentials);
      });
      process.stdout.write(`${paths.name}: ${result.status ?? 'deleted'}\n`); return;
    }
    const status = await statusSandbox(state, credentials);
    if (command === 'status') {
      process.stdout.write(`${paths.name}: ${status.status}\n${status.expiresAt ? 'Session ends: ' + status.expiresAt + '\n' : ''}SSH host: ${paths.alias}\n`); return;
    }
    if (status.status !== 'running') throw new Error(`Host is ${status.status}. Run: emdash-sandbox start --host ${paths.name}`);
    const options = optionsFor(state, paths.stateDir);
    if (command === 'tasks') { process.stdout.write(JSON.stringify(await listTasks(options), null, 2) + '\n'); return; }
    let selection = flags.worktree;
    if (!selection) {
      const tasks = await listTasks(options);
      selection = (await choose(tasks.map(task => ({ ...task, name: (task.branch?.replace('refs/heads/', '') ?? 'detached') + ' — ' + task.path })), 'Task', ui)).path;
    }
    process.stderr.write('Exporting task. Keep it idle until export finishes.\n');
    const result = await exportProject({ state, stateDir: paths.stateDir, destination: flags.destination, worktreeName: selection, privateKey: options.privateKey, credentials });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { ui.close(); }
}
