import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('loading agent paths preserves the maintenance shell PATH', () => {
  const asset = fileURLToPath(new URL('../src/assets/runtime-env.sh', import.meta.url));
  const output = execFileSync('/bin/bash', ['-eu', '-c',
    'before="$PATH"; source "$1"; test "$PATH" = "$before"; printf "%s" "$EMDASH_USER_PATH"',
    'path-check', asset], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  const directories = output.split(':');
  assert.ok(directories.includes('/home/emdash/.local/bin'));
  assert.ok(directories.includes('/vercel/.local/bin'));
  assert.ok(directories.includes('/usr/local/bin'));
  assert.ok(directories.every(directory => directory.startsWith('/')));
});
