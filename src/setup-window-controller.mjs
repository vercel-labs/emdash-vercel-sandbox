import fs from 'node:fs/promises';
import path from 'node:path';
import { getAuth, OAuth } from '@vercel/sandbox/dist/auth/index.js';
import { api, deviceLogin, listChoices, validateScope, hostCredentials } from './connection.mjs';
import { hostPaths, readRegular, withConnectionLock, writeConnection, digest } from './host-files.mjs';
import { setupHost, runHostCli } from './host-cli.mjs';
import { statusSandbox } from './lifecycle.mjs';
import { readState } from './state.mjs';

export function cachedConnection(auth = getAuth(), now = Date.now) {
  return auth?.token && (!auth.expiresAt || auth.expiresAt.getTime() > now() + 60000) ? { type: 'cached-cli' } : null;
}
export async function searchProjects(token, teamId, search = '', cursor, fetchImpl = fetch) {
  if (typeof teamId !== 'string' || !teamId || typeof search !== 'string' || search.length > 100) throw new Error('Choose a team and a project name of at most 100 characters.');
  const query = new URLSearchParams({ teamId, limit: '20' });
  if (search.trim()) query.set('search', search.trim());
  if (cursor !== undefined && cursor !== null) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid project page. Search again.');
    query.set('until', String(cursor));
  }
  const result = await api(token, '/v9/projects?' + query, fetchImpl);
  if (!Array.isArray(result.projects) || result.projects.length > 20 || result.projects.some(p => !p || typeof p.id !== 'string' || typeof p.name !== 'string')) throw new Error('Unexpected Vercel project response.');
  const next = result.pagination?.next ?? null;
  if (next !== null && (!Number.isSafeInteger(next) || next < 0 || (cursor != null && next >= cursor))) throw new Error('Could not load the next project page. Search again.');
  return { items: result.projects.map(({ id, name }) => ({ id, name })), next };
}

export function createController({ login = deviceLogin, cached = getAuth, fetchImpl = fetch, setup = setupHost, hostCommand = runHostCli, root, now = Date.now, readHostState = readState, credentialsForHost = hostCredentials, remoteStatus = statusSandbox } = {}) {
  let connection, phase = 'signed-out', message, authUrl, ready, busy = false;
  let teams = [], projectChoices = new Map(), hostCache, hostCacheAt=0, hostsPending;
  const pathsFor = name => hostPaths(name, root);
  const safeError = error => {
    const text = error instanceof Error ? error.message : '';
    if (/^(Vercel request failed \(HTTP \d{3}\)|Could not reach Vercel|Vercel sign-in|Choose a team|Choose a project|Host name must|A host with this name|Sign in|Search|Unexpected Vercel|Could not load|Invalid project|Another operation)/.test(text)) return text.slice(0,300);
    return 'This step could not finish. Your existing hosts and files are retained. Try again with the same host name.';
  };
  async function token() {
    if (!connection) throw new Error('Sign in to Vercel first.');
    if (connection.type === 'cached-cli') {
      const auth = cached();
      if (!cachedConnection(auth, now)) throw new Error('Vercel sign-in expired. Use Sign in to renew it.');
      return auth.token;
    }
    if (connection.expiresAt <= now() + 60000) {
      let result;
      try { result = await (await OAuth()).refreshToken(connection.refreshToken); }
      catch { throw new Error('Vercel sign-in needs renewal. Use Sign in again.'); }
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || (result.refresh_token !== undefined && (typeof result.refresh_token !== 'string' || !result.refresh_token))) throw new Error('Unexpected Vercel refresh response.');
      Object.assign(connection, { token: result.access_token, refreshToken: result.refresh_token ?? connection.refreshToken, expiresAt: now() + result.expires_in * 1000 });
    }
    return connection.token;
  }
  async function listHosts() {
    const directory = path.dirname(pathsFor('placeholder').directory);
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(e => { if(e.code==='ENOENT') return []; throw e; });
    const result = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.name)) continue;
      const p = pathsFor(entry.name);
      let status = 'setup incomplete';
      try { const s = await readHostState(p.stateDir); status = s.status;
        if (!['preparing','allocating','provisioning'].includes(s.setupPhase)) {
          try { status=(await remoteStatus(s,await credentialsForHost(p))).status; } catch { status='status unavailable'; }
        } else status='setup incomplete';
      } catch {}
      const raw=await readRegular(p.connection,{privateFile:true,missing:true}).catch(()=>null);
      let saved;try{saved=raw?JSON.parse(raw):undefined;}catch{}
      const canSignIn=!!raw;
      const scope=[saved?.teamName,saved?.projectName].filter(v=>typeof v==='string'&&v.length<=200).join(' / ');
      result.push({ name: p.name, alias: p.alias, status, canSignIn, scope });
    }
    return result;
  }
  async function hosts() {
    if(hostCache && (busy || now()-hostCacheAt<15000))return hostCache;
    hostsPending ??= listHosts().then(items=>{hostCache=items;hostCacheAt=now();return items;}).finally(()=>{hostsPending=undefined;});
    return hostsPending;
  }
  function background(nextPhase, action) {
    if (busy) throw new Error('Another operation is in progress.');
    busy=true;phase=nextPhase;message=undefined;
    Promise.resolve().then(action).catch(error=>{phase='error';message=safeError(error);}).finally(()=>{busy=false;authUrl=undefined;hostCacheAt=0;});
    return { accepted: true };
  }
  return {
    busy: () => busy,
    state: async () => ({ phase, message, authUrl, ready, busy, signedIn: !!connection, cachedLoginAvailable: !!cachedConnection(cached(), now), hosts: await hosts() }),
    async dispatch(route, data) {
      if (busy) throw new Error('Another operation is in progress.');
      if (route === 'login') {
        if (!['cached','browser'].includes(data.method)) throw new Error('Sign in with an available method.');
        return background('authorizing', async () => {
          connection=undefined;teams=[];projectChoices.clear();ready=undefined;
          if (data.method==='cached') {
            connection=cachedConnection(cached(),now);
            if(!connection) throw new Error('Vercel sign-in expired. Use Sign in.');
            await api(token, '/v2/user', fetchImpl);
          } else connection=await login({ show: ({url}) => { const u=new URL(url);if(u.origin!=='https://vercel.com')throw new Error('Unexpected Vercel authorization address.');authUrl=u.href; } });
          phase='signed-in';
        });
      }
      if(route==='teams') { teams=await listChoices(token,undefined,fetchImpl);return {items:teams}; }
      if(route==='projects') {
        if(!teams.some(t=>t.id===data.teamId))throw new Error('Choose a team from your account.');
        const result=await searchProjects(token,data.teamId,data.search,data.cursor,fetchImpl);
        for(const p of result.items)projectChoices.set(data.teamId+'\0'+p.id,p);
        return result;
      }
      if(route==='create') {
        const p=pathsFor(data.name);
        if(data.confirm!==true)throw new Error('Choose a project and confirm creation.');
        const team=teams.find(t=>t.id===data.teamId), project=projectChoices.get(data.teamId+'\0'+data.projectId);
        if(!team||!project)throw new Error('Choose a project from the search results.');
        return background('creating',async()=>{
          const scope=await validateScope(token,team.id,project.id,fetchImpl);
          const existing=await readRegular(p.connection,{privateFile:true,missing:true});
          if(existing) { const saved=JSON.parse(existing);if(saved.teamId!==team.id||saved.projectId!==project.id)throw new Error('A host with this name belongs to another project. Choose a different host name.'); }
          const stateFile=await readRegular(path.join(p.stateDir,'state.json'),{privateFile:true,missing:true});
          if(stateFile && !['preparing','allocating','provisioning'].includes(JSON.parse(stateFile).setupPhase))throw new Error('A host with this name is already set up. Use its Start button or choose a different name.');
          const preparedConnection={...connection,...scope,teamName:team.name};
          connection=undefined;teams=[];projectChoices.clear();
          await setup({name:p.name,yes:true}, {ask:async()=>{throw new Error('Unexpected terminal prompt');}}, {preparedConnection});
          ready={name:p.name,alias:p.alias};phase='ready';
        });
      }
      if(route==='host') {
        const p=pathsFor(data.name);
        if(!['start','stop','login','retry'].includes(data.action))throw new Error('Choose a host action.');
        if(data.action==='retry') {
          if(data.confirm!==true)throw new Error('Choose a host and confirm setup.');
          const raw=await readRegular(p.connection,{privateFile:true,missing:true});
          if(!raw)throw new Error('Sign in and select a project to finish this host.');
          return background('creating',async()=>{
            await setup({name:p.name,yes:true},{ask:async()=>{throw new Error('Unexpected terminal prompt');}});
            ready={name:p.name,alias:p.alias};phase='ready';
          });
        }
        if(data.action==='login')return background('authorizing',async()=>{
          await withConnectionLock(p,async()=>{
            const raw=await readRegular(p.connection,{privateFile:true});
            const saved=JSON.parse(raw);
            const fresh=await login({show:({url})=>{const u=new URL(url);if(u.origin!=='https://vercel.com')throw new Error('Unexpected Vercel authorization address.');authUrl=u.href;}});
            await validateScope(fresh.token,saved.teamId,saved.projectId,fetchImpl);
            await writeConnection(p,{...saved,...fresh},digest(raw));
          });
          phase=connection?'signed-in':'signed-out';message=p.alias+' sign-in renewed.';
        });
        return background('creating',async()=>{
          await hostCommand([data.action,'--host',p.name]);
          if(data.action==='start'){ready={name:p.name,alias:p.alias};phase='ready';}
          else {ready=undefined;phase=connection?'signed-in':'signed-out';}
          message=p.alias+(data.action==='start'?' is ready to connect.':' is stopped.');
        });
      }
      throw new Error('Unknown setup action.');
    },
    safeError,
  };
}
