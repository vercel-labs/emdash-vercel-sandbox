import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deviceLogin, listChoices, validateScope, hostCredentials } from '../src/connection.mjs';
import { hostPaths, writeConnection } from '../src/host-files.mjs';

test('browser sign-in honors pending/slow_down and never exposes device or access token in the prompt', async () => {
  let clock = 0, polls = 0, shown;
  const waits = [];
  const oauth = {
    deviceAuthorizationRequest: async () => ({ verification_uri_complete: 'https://vercel.com/device?code=USER', user_code: 'USER', device_code: 'secret-device', interval: 1, expiresAt: 20000 }),
    deviceAccessTokenRequest: async code => { assert.equal(code, 'secret-device'); return [null, {}]; },
    processTokenResponse: async () => ++polls === 1 ? [{ code: 'authorization_pending' }] : polls === 2 ? [{ code: 'slow_down' }] : [null, { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }],
  };
  const result = await deviceLogin({ oauthFactory: async () => oauth, show: x => { shown = x; }, sleep: async ms => { waits.push(ms); clock += ms; }, now: () => clock });
  assert.deepEqual(waits, [1000, 1000, 6000]);
  assert.deepEqual(shown, { url: 'https://vercel.com/device?code=USER', code: 'USER' });
  assert.equal(result.token, 'access'); assert.equal(result.expiresAt, 3608000);
});

test('denied, expired and unexpected-origin login never become a saved connection', async () => {
  for (const mode of ['denied', 'expired', 'origin']) {
    let clock = 0, shown = 0;
    const oauth = {
      deviceAuthorizationRequest: async () => ({ verification_uri_complete: mode === 'origin' ? 'https://example.com/' : 'https://vercel.com/device', user_code: 'USER', device_code: 'device', interval: 1, expiresAt: mode === 'expired' ? 500 : 2000 }),
      deviceAccessTokenRequest: async () => [null, {}], processTokenResponse: async () => [{ code: 'access_denied' }],
    };
    await assert.rejects(deviceLogin({ oauthFactory: async () => oauth, show: () => { shown++; }, sleep: async ms => { clock += ms; }, now: () => clock }), /declined|expired|unexpected/);
    assert.equal(shown, mode === 'origin' ? 0 : 1);
  }
});

test('team and project selection paginates and refuses a mismatched project owner', async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(url); assert.equal(init.headers.authorization, 'Bearer token');
    return { ok: true, json: async () => requests.length === 1 ? { teams: [{ id: 'one', name: 'One' }], pagination: { next: 123 } } : { teams: [{ id: 'two', name: 'Two' }], pagination: { next: null } } };
  };
  assert.equal((await listChoices('token', undefined, fetchImpl)).length, 2);
  assert.match(requests[1], /until=123/);
  await assert.rejects(validateScope('token', 'team', 'project', async () => ({ ok: true, json: async () => ({ id: 'project', accountId: 'other-team' }) })), /does not belong/);
});

test('refresh stores rotated tokens privately; failed refresh preserves existing connection', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'emdash-auth-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = hostPaths('test', root);
  await writeConnection(paths, { type: 'oauth', token: 'old', refreshToken: 'refresh', expiresAt: 0, teamId: 'team', projectId: 'project' }, 'MISSING');
  const got = await hostCredentials(paths, { now: () => 1000, oauthFactory: async () => ({ refreshToken: async value => { assert.equal(value, 'refresh'); return { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }; } }) });
  assert.deepEqual(got, { token: 'new', teamId: 'team', projectId: 'project' });
  assert.equal((await fs.stat(paths.connection)).mode & 0o077, 0);
  const before = await fs.readFile(paths.connection);
  await assert.rejects(hostCredentials(paths, { now: () => 9999999, oauthFactory: async () => ({ refreshToken: async () => { throw new Error('private server output'); } }) }), /login --host test/);
  assert.deepEqual(await fs.readFile(paths.connection), before);
});
