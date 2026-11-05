import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProjects, cachedConnection } from '../src/setup-window-controller.mjs';
import { createSetupServer } from '../src/setup-window-server.mjs';

test('project search fetches one bounded page, encodes input and exposes names only', async () => {
 let called;
 const result=await searchProjects('token','team','my project',undefined,async(url,init)=>{
  called=new URL(url);assert.equal(init.headers.authorization,'Bearer token');
  return {ok:true,json:async()=>({projects:[{id:'p',name:'Project',env:[{value:'private'}]}],pagination:{next:123}})};
 });
 assert.equal(called.searchParams.get('limit'),'20');assert.equal(called.searchParams.get('search'),'my project');
 assert.deepEqual(result,{items:[{id:'p',name:'Project'}],next:123});
});

test('cached login references global access without cloning renewable credentials',()=>{
 assert.deepEqual(cachedConnection({token:'access',refreshToken:'private',expiresAt:new Date(100000)},()=>0),{type:'cached-cli'});
 assert.equal(cachedConnection({token:'expired',expiresAt:new Date(0)},()=>1),null);
 assert.equal(cachedConnection(null),null);
});

test('local HTTP API rejects missing capability, foreign origin and Host before controller actions',async t=>{
 let calls=0;
 const controller={state:async()=>({phase:'signed-out',hosts:[],busy:false}),dispatch:async()=>{calls++;return{};},busy:()=>false};
 const app=await createSetupServer({controller});t.after(()=>app.close());
 const base=app.origin;
 assert.equal((await fetch(base+'/api/state')).status,403);
 assert.equal((await fetch(base+'/api/state',{headers:{authorization:'Bearer '+app.capability,origin:'https://foreign.example'}})).status,403);
 const {request}=await import('node:http');
 const foreign=await new Promise((resolve,reject)=>{const r=request(base+'/api/state',{headers:{authorization:'Bearer '+app.capability,host:'foreign.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});
 assert.equal(foreign,403);
 assert.equal((await fetch(base+'/api/state',{headers:{authorization:'Bearer '+app.capability}})).status,200);
 assert.equal((await fetch(base+'/api/create',{method:'POST',headers:{authorization:'Bearer '+app.capability,'content-type':'text/plain'},body:'{}'})).status,415);
 assert.equal((await fetch(base+'/api/create',{method:'POST',headers:{authorization:'Bearer '+app.capability,'content-type':'application/json'},body:'x'.repeat(17000)})).status,413);
 assert.equal(calls,0);
});


test('window controller uses cached auth, validates scope, serializes creation, and never returns credentials',async t=>{
 const {createController}=await import('../src/setup-window-controller.mjs');
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'emdash-window-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let complete,creation=0,prepared;
 const controller=createController({root,cached:()=>({token:'private-access',refreshToken:'private-refresh'}),fetchImpl:async url=>({ok:true,json:async()=>{
 const u=new URL(url);if(u.pathname==='/v2/user')return {user:{name:'Me'}};
 if(u.pathname==='/v2/teams')return {teams:[{id:'team',name:'Team'}]};
 if(u.pathname==='/v9/projects')return {projects:[{id:'project',name:'Project'}],pagination:{next:null}};
 return {id:'project',accountId:'team',name:'Project'};
 }}),setup:async(flags,ui,options)=>{creation++;prepared=options.preparedConnection;await new Promise(r=>complete=r);}});
 const settle=async()=>{for(let i=0;i<100&&controller.busy();i++)await new Promise(r=>setTimeout(r,5));};
 await controller.dispatch('login',{method:'cached'});await settle();
 await controller.dispatch('teams',{});await controller.dispatch('projects',{teamId:'team',search:'project'});
 await assert.rejects(controller.dispatch('create',{name:'demo',teamId:'team',projectId:'other',confirm:true}),/Choose a project/);
 await controller.dispatch('create',{name:'demo',teamId:'team',projectId:'project',confirm:true});
 await assert.rejects(controller.dispatch('create',{name:'demo',teamId:'team',projectId:'project',confirm:true}),/Another operation/);
 for(let i=0;i<100&&!complete;i++)await new Promise(r=>setTimeout(r,5));
 assert.equal(creation,1);assert.equal(prepared.type,'cached-cli');assert.equal(prepared.token,undefined);assert.equal(prepared.refreshToken,undefined);
 assert.doesNotMatch(JSON.stringify(await controller.state()),/private-access|private-refresh/);
 complete();await settle();assert.equal((await controller.state()).ready.alias,'vercel-demo');
 assert.equal((await controller.state()).signedIn,false);
 await assert.rejects(controller.dispatch('create',{name:'second',teamId:'team',projectId:'project',confirm:true}),/Choose a project/);
});

test('project search preserves pagination and rejects invalid scope and provider payloads',async()=>{
 let url;
 const result=await searchProjects('token','team','a&b',123,async u=>{url=new URL(u);return{ok:true,json:async()=>({projects:[],pagination:{next:null}})};});
 assert.equal(url.searchParams.get('search'),'a&b');assert.equal(url.searchParams.get('until'),'123');assert.equal(result.next,null);
 await assert.rejects(searchProjects('token','team','x',123,async()=>({ok:true,json:async()=>({projects:[],pagination:{next:123}})})),/next project page/);
 await assert.rejects(searchProjects('token','team','x',-1),/Invalid project page/);
});


test('saved host browser renewal validates scope and atomically preserves host identity',async t=>{
 const {createController}=await import('../src/setup-window-controller.mjs');
 const {hostPaths,writeConnection}=await import('../src/host-files.mjs');
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'emdash-window-renew-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const p=hostPaths('saved',root);await writeConnection(p,{type:'cached-cli',teamId:'team',projectId:'project'},'MISSING');
 let owner='wrong';
 const c=createController({root,cached:()=>null,login:async({show})=>{show({url:'https://vercel.com/device'});return {type:'oauth',token:'private',refreshToken:'renewable',expiresAt:Date.now()+100000};},fetchImpl:async()=>({ok:true,json:async()=>({id:'project',accountId:owner})})});
 const settle=async()=>{for(let n=0;n<100&&c.busy();n++)await new Promise(r=>setTimeout(r,5));};
 const initial=await c.state();assert.equal(initial.hosts[0].status,'setup incomplete');assert.equal(initial.hosts[0].canSignIn,true);
 const before=await fs.readFile(p.connection);
 await c.dispatch('host',{name:'saved',action:'login'});await settle();assert.deepEqual(await fs.readFile(p.connection),before);
 owner='team';await c.dispatch('host',{name:'saved',action:'login'});await settle();
 const saved=JSON.parse(await fs.readFile(p.connection));assert.equal(saved.type,'oauth');assert.equal(saved.teamId,'team');assert.equal(saved.projectId,'project');assert.equal(saved.refreshToken,'renewable');
 assert.doesNotMatch(JSON.stringify(await c.state()),/private|renewable/);
});
