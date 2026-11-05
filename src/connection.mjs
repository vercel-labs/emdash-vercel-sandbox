import { setTimeout as delay } from 'node:timers/promises';
import { OAuth } from '@vercel/sandbox/dist/auth/index.js';
import { digest, readRegular, withConnectionLock, writeConnection } from './host-files.mjs';
import { resolveCredentials } from './credentials.mjs';

export async function deviceLogin({ show, oauthFactory = OAuth, sleep = delay, now = Date.now }) {
  const oauth = await oauthFactory();
  const request = await oauth.deviceAuthorizationRequest();
  const url = new URL(request.verification_uri_complete);
  if (url.origin !== 'https://vercel.com') throw new Error('Vercel returned an unexpected authorization address');
  await show({ url: url.toString(), code: request.user_code });
  let interval = Math.max(1, request.interval) * 1000;
  while (now() < request.expiresAt) {
    await sleep(interval);
    if (now() >= request.expiresAt) break;
    const [networkError, response] = await oauth.deviceAccessTokenRequest(request.device_code);
    if (networkError) throw new Error('Could not reach Vercel sign-in. Run setup again.');
    const [error, result] = await oauth.processTokenResponse(response);
    if (error?.code === 'authorization_pending') continue;
    if (error?.code === 'slow_down') { interval += 5000; continue; }
    if (error) throw new Error(error.code === 'access_denied' ? 'Vercel sign-in was declined. Run setup again.' : 'Vercel sign-in expired. Run setup again.');
    if (!result.refresh_token) {
      await oauth.revokeToken(result.access_token);
      throw new Error('Vercel did not provide renewable access. Sign in again.');
    }
    return { type: 'oauth', token: result.access_token, refreshToken: result.refresh_token, expiresAt: now() + result.expires_in * 1000 };
  }
  throw new Error('Vercel sign-in expired. Run setup again.');
}

export async function api(token, route, fetchImpl = fetch) {
  const accessToken = typeof token === 'function' ? await token() : token;
  let response;
  try {
    response = await fetchImpl('https://api.vercel.com' + route, { headers: { authorization: 'Bearer ' + accessToken }, signal: AbortSignal.timeout(15000) });
  } catch { throw new Error('Could not reach Vercel. Check your connection and try again.'); }
  if (!response.ok) {
    const action = response.status === 401 ? 'Sign in again.'
      : response.status === 403 ? 'Check your selected team/project access or sign in again.'
      : response.status === 429 ? 'Wait a moment and try again.' : 'Try again; if this continues, report this status.';
    throw new Error(`Vercel request failed (HTTP ${response.status}). ${action}`);
  }
  return response.json();
}

export async function listChoices(token, teamId, fetchImpl) {
  const items = [], seen = new Set();
  let cursor;
  do {
    const query = new URLSearchParams({ limit: '100' });
    if (teamId) query.set('teamId', teamId);
    if (cursor !== undefined) query.set('until', String(cursor));
    const result = await api(token, (teamId ? '/v9/projects?' : '/v2/teams?') + query, fetchImpl);
    const page = teamId ? result.projects : result.teams;
    if (!Array.isArray(page) || page.some(x => !x || typeof x.id !== 'string' || typeof x.name !== 'string')) throw new Error('Unexpected Vercel team/project response');
    for (const item of page) if (!seen.has(item.id)) { seen.add(item.id); items.push({ id: item.id, name: item.name }); }
    const next = result.pagination?.next;
    if (next == null) break;
    if (!Number.isSafeInteger(next) || next < 0 || (cursor !== undefined && next >= cursor) || items.length > 10000) throw new Error('Could not finish listing Vercel teams/projects');
    cursor = next;
  } while (true);
  return items;
}

export async function validateScope(token, teamId, projectId, fetchImpl) {
  const project = await api(token, '/v9/projects/' + encodeURIComponent(projectId) + '?teamId=' + encodeURIComponent(teamId), fetchImpl);
  if (project.id !== projectId || project.accountId !== teamId) throw new Error('Selected project does not belong to the selected team');
  return { teamId, projectId, projectName: project.name };
}

export async function selectSetupScope(connection, choose, { oauthFactory = OAuth, now = Date.now, fetchImpl } = {}) {
  const token = async () => {
    if (connection.expiresAt <= now() + 60000) {
      let result;
      try { result = await (await oauthFactory()).refreshToken(connection.refreshToken); }
      catch { throw new Error('Vercel sign-in needs renewal. Run setup again.'); }
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || (result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || !result.refresh_token))) {
        throw new Error('Unexpected Vercel refresh response. Run setup again.');
      }
      Object.assign(connection, { token: result.access_token, refreshToken: result.refresh_token ?? connection.refreshToken, expiresAt: now() + result.expires_in * 1000 });
    }
    return connection.token;
  };
  const team = await choose(await listChoices(token, undefined, fetchImpl), 'Team');
  const project = await choose(await listChoices(token, team.id, fetchImpl), 'Project');
  Object.assign(connection, await validateScope(token, team.id, project.id, fetchImpl), { teamName: team.name });
  return connection;
}

export function parseConnection(raw) {
  const c = JSON.parse(raw);
  if (!c || !['oauth', 'cli', 'cached-cli'].includes(c.type) || typeof c.teamId !== 'string' || typeof c.projectId !== 'string') throw new Error('Invalid saved Vercel connection');
  if (c.type === 'oauth' && (typeof c.token !== 'string' || !c.token || typeof c.refreshToken !== 'string' || !c.refreshToken || !Number.isFinite(c.expiresAt))) throw new Error('Invalid saved Vercel sign-in');
  if (c.type === 'cli' && typeof c.projectConfig !== 'string') throw new Error('Invalid saved CLI connection');
  return c;
}

export async function hostCredentials(paths, { oauthFactory = OAuth, now = Date.now } = {}) {
  return withConnectionLock(paths, async () => {
    const raw = await readRegular(paths.connection, { privateFile: true });
    const connection = parseConnection(raw);
    if (connection.type === 'cached-cli') {
      const { getAuth } = await import('@vercel/sandbox/dist/auth/index.js');
      const auth = getAuth();
      if (!auth?.token || (auth.expiresAt && auth.expiresAt.getTime() <= now() + 60000)) throw new Error(`Vercel sign-in needs renewal. Run: emdash-sandbox login --host ${paths.name}`);
      return { token: auth.token, teamId: connection.teamId, projectId: connection.projectId };
    }
    if (connection.type === 'cli') {
      const credentials = await resolveCredentials({ projectConfig: connection.projectConfig, ignoreEnvironment: true });
      if (credentials.teamId !== connection.teamId || credentials.projectId !== connection.projectId) throw new Error('Linked project changed. Restore its original team/project before managing this host.');
      return credentials;
    }
    if (connection.expiresAt <= now() + 60000) {
      let result;
      try { result = await (await oauthFactory()).refreshToken(connection.refreshToken); }
      catch { throw new Error(`Vercel sign-in needs renewal. Run: emdash-sandbox login --host ${paths.name}`); }
      if (!result.access_token || !Number.isFinite(result.expires_in)) throw new Error('Unexpected Vercel refresh response');
      connection.token = result.access_token;
      connection.refreshToken = result.refresh_token ?? connection.refreshToken;
      connection.expiresAt = now() + result.expires_in * 1000;
      await writeConnection(paths, connection, digest(raw));
    }
    return { token: connection.token, teamId: connection.teamId, projectId: connection.projectId };
  });
}
