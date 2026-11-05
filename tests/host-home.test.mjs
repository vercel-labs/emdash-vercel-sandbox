import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostActions, homeView } from '../src/assets/setup-presentation.mjs';
import { createController } from '../src/setup-window-controller.mjs';
import { hostPaths, writeConnection } from '../src/host-files.mjs';
const settle = async c => { for (let i=0;i<100&&c.busy();i++) await new Promise(r=>setTimeout(r,5)); assert.equal(c.busy(),false); };

test('returning hosts hide new setup, with an explicit route back to creation', () => {
  assert.equal(homeView({}).showSetup, true);
  const hosts=[{name:'existing'}];
  assert.deepEqual(homeView({hosts}),{showSetup:false,showHosts:true,connectionLabel:'Saved hosts'});
  assert.equal(homeView({hosts,creatingAnother:true}).showSetup,true);
  assert.equal(homeView({hosts,creatingAnother:true,ready:true}).showSetup,false);
  assert.deepEqual(hostActions({status:'running'}),['connect','stop']);
  assert.deepEqual(hostActions({status:'stopped',canSignIn:true}),['start','login']);
  assert.deepEqual(hostActions({status:'status unavailable',canSignIn:true}),['refresh','login']);
  assert.deepEqual(hostActions({status:'setup incomplete',canSignIn:true}),['retry','login']);
});

test('saved-host startup needs no new CLI login and exposes only persisted scope names',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'emdash-home-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const p=hostPaths('existing',root);
  await writeConnection(p,{type:'oauth',token:'secret-access',refreshToken:'secret-refresh',expiresAt:1,teamId:'team',projectId:'project',teamName:'My team',projectName:'My project'},'MISSING');
  let status='stopped',calls=[];
  const c=createController({root,cached:()=>null,readHostState:async()=>({status,setupPhase:'ready'}),credentialsForHost:async()=>({token:'secret-access'}),remoteStatus:async()=>({status}),hostCommand:async args=>{calls.push(args);status='running';}});
  const state=await c.state();
  assert.equal(state.signedIn,false);assert.equal(state.hosts[0].scope,'My team / My project');
  assert.doesNotMatch(JSON.stringify(state),/secret-access|secret-refresh/);
  assert.deepEqual(calls,[]);
  await c.dispatch('host',{name:'existing',action:'start'});await settle(c);
  assert.deepEqual(calls,[['start','--host','existing']]);
  const after=await c.state();assert.equal(after.ready.alias,'vercel-existing');assert.equal(after.phase,'ready');assert.equal(after.signedIn,false);
});

test('incomplete host retry requires explicit compute confirmation and reuses same saved host',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'emdash-retry-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await writeConnection(hostPaths('unfinished',root),{type:'cached-cli',teamId:'team',projectId:'project'},'MISSING');
  const calls=[];const c=createController({root,cached:()=>null,setup:async flags=>calls.push(flags),readHostState:async()=>({status:'pending',setupPhase:'allocating'})});
  assert.equal((await c.state()).hosts[0].status,'setup incomplete');
  await assert.rejects(c.dispatch('host',{name:'unfinished',action:'retry'}),/confirm setup/);
  assert.equal(calls.length,0);
  await c.dispatch('host',{name:'unfinished',action:'retry',confirm:true});await settle(c);
  assert.deepEqual(calls,[{name:'unfinished',yes:true}]);
  assert.equal((await c.state()).ready.alias,'vercel-unfinished');
  await assert.rejects(c.dispatch('host',{name:'absent',action:'retry',confirm:true}),/Sign in/);
});


test('a browser grant is consumed even when host setup fails, so a second host needs a new grant',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'emdash-grant-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let grants=0;const saved=[];
 const c=createController({root,cached:()=>null,login:async()=>({type:'oauth',token:'access-'+(++grants),refreshToken:'refresh-'+grants,expiresAt:Date.now()+1000000}),fetchImpl:async url=>({ok:true,json:async()=>{
  const pathname=new URL(url).pathname;
  if(pathname==='/v2/teams')return{teams:[{id:'team',name:'Team'}]};
  if(pathname==='/v9/projects')return{projects:[{id:'project',name:'Project'}],pagination:{next:null}};
  return{id:'project',accountId:'team',name:'Project'};
 }}),setup:async(flags,ui,options)=>{saved.push({name:flags.name,refresh:options.preparedConnection.refreshToken});throw new Error('fixture setup failure');}});
 const authorize=async()=>{await c.dispatch('login',{method:'browser'});await settle(c);await c.dispatch('teams',{});await c.dispatch('projects',{teamId:'team'});};
 await authorize();await c.dispatch('create',{name:'one',teamId:'team',projectId:'project',confirm:true});await settle(c);
 assert.equal((await c.state()).signedIn,false);
 await assert.rejects(c.dispatch('create',{name:'two',teamId:'team',projectId:'project',confirm:true}),/Choose a project/);
 await authorize();await c.dispatch('create',{name:'two',teamId:'team',projectId:'project',confirm:true});await settle(c);
 assert.equal(grants,2);assert.notEqual(saved[0].refresh,saved[1].refresh);
});
