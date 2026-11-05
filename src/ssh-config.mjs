import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensurePrivateStateDir } from './state.mjs';
import { digest, readRegular, replaceFile } from './host-files.mjs';
import { publicKeyBlob } from './keys.mjs';

function safePath(value) {
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f%$]/.test(value)) throw new Error('SSH integration needs absolute paths without control characters, % or $');
  return value;
}
export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const configQuote = value => '"' + safePath(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

export function hostBlock(paths, { node = process.execPath, bin = fileURLToPath(new URL('../bin/emdash-sandbox.mjs', import.meta.url)) } = {}) {
  const args = [safePath(node), safePath(bin), 'proxy', '--state-dir', safePath(paths.stateDir)].map(shellQuote).join(' ');
  return `# BEGIN emdash-sandbox ${paths.alias}\nHost ${paths.alias}\n  HostName 127.0.0.1\n  Port 2222\n  User emdash\n  IdentityFile ${configQuote(path.join(paths.stateDir, 'id_ed25519'))}\n  IdentitiesOnly yes\n  HostKeyAlias ${paths.alias}\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${configQuote(path.join(paths.directory, 'known_hosts'))}\n  ProxyCommand ${args}\nHost *\n# END emdash-sandbox ${paths.alias}\n`;
}


export function sshConfigWords(line) {
  const words = [];
  let word = '', quote = '', escaped = false, active = false;
  for (const character of line) {
    if (escaped) { word += character; escaped = false; active = true; continue; }
    if (character === '\\') { escaped = true; active = true; continue; }
    if (quote) { if (character === quote) quote = ''; else word += character; active = true; continue; }
    if (character === '"' || character === "'") { quote = character; active = true; continue; }
    if (character === '#') break;
    if (/\s/.test(character) || (character === '=' && words.length === 0)) {
      if (active) { words.push(word); word = ''; active = false; }
    } else { word += character; active = true; }
  }
  if (quote || escaped) throw new Error('SSH config contains an unterminated quote or escape; fix it before setup');
  if (active) words.push(word);
  return words;
}

async function assertAliasAvailable(text, alias, seen = new Set()) {
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*(?:Host|Include)(?:\s|=)/i.test(line)) continue;
    const [keyword, ...values] = sshConfigWords(line);
    if (keyword?.toLowerCase() === 'host' && values.some(value => value.toLowerCase() === alias)) throw new Error('SSH host already exists: ' + alias);
    if (keyword?.toLowerCase() !== 'include') continue;
    for (let pattern of values) {
      pattern = pattern.replace(/^~\//, os.homedir() + '/').replace(/\$\{([^}]+)\}/g, (_, name) => {
        if (!(name in process.env)) throw new Error('SSH Include references an unset environment variable');
        return process.env[name];
      });
      if (pattern.includes('%') || /^~/.test(pattern)) throw new Error('Resolve SSH Include tokens before adding this host');
      if (!path.isAbsolute(pattern)) pattern = path.join(os.homedir(), '.ssh', pattern);
      for await (const file of fs.glob(pattern)) {
        if (seen.has(file)) continue;
        if (seen.size >= 128) throw new Error('SSH configuration includes too many files');
        seen.add(file);
        const bytes = await readRegular(file);
        await assertAliasAvailable(bytes.toString('utf8'), alias, seen);
      }
    }
  }
}

export async function registerHost(paths, state, { configFile = path.join(os.homedir(), '.ssh/config'), ...runtime } = {}) {
  const block = hostBlock(paths, runtime);
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+=*(?: [^\r\n]*)?$/.test(state.hostPublicKey)) throw new Error('Invalid saved SSH host identity');
  publicKeyBlob(state.hostPublicKey);
  await ensurePrivateStateDir(paths.directory);
  await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(path.dirname(configFile))).isDirectory()) throw new Error('SSH configuration directory must not be a symlink');
  const raw = await readRegular(configFile, { missing: true });
  const text = raw?.toString('utf8') ?? '';
  const marker = `# BEGIN emdash-sandbox ${paths.alias}\n`;
  if (text.includes(marker)) {
    if (!text.includes(block)) throw new Error('This host has different saved SSH settings. Preserve the existing entry and resolve it before retrying.');
  } else {
    await assertAliasAvailable(text, paths.alias);
  }
  const known = path.join(paths.directory, 'known_hosts');
  const knownBytes = Buffer.from(paths.alias + ' ' + state.hostPublicKey.split(/\s+/).slice(0, 2).join(' ') + '\n');
  const prior = await readRegular(known, { privateFile: true, missing: true });
  if (prior && !prior.equals(knownBytes)) throw new Error('SSH host identity mismatch; refusing to replace the pinned key');
  if (!prior) await replaceFile(known, knownBytes, 'MISSING', path.join(paths.directory, 'receipts'));
  if (!text.includes(marker)) await replaceFile(configFile, block + '\n' + text, digest(raw), path.join(paths.directory, 'receipts'));
  return { alias: paths.alias, configFile };
}
