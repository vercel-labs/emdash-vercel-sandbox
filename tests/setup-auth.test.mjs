import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSetupScope, listChoices } from '../src/connection.mjs';

test('initial setup refreshes after user pauses and preserves rotation through pagination and validation', async () => {
  let clock=0, refreshes=0; const requests=[];
  const connection={type:'oauth',token:'original',refreshToken:'refresh-0',expiresAt:100000};
  const oauthFactory=async()=>({refreshToken:async token=>{
    assert.equal(token,'refresh-'+refreshes); refreshes++;
    return {access_token:'token-'+refreshes,refresh_token:'refresh-'+refreshes,expires_in:3600};
  }});
  const fetchImpl=async(url,init)=>{
    requests.push({url,token:init.headers.authorization}); const parsed=new URL(url);
    if(parsed.pathname==='/v2/teams')return {ok:true,json:async()=>({teams:[{id:'team',name:'Team'}]})};
    if(parsed.pathname==='/v9/projects')return {ok:true,json:async()=>parsed.searchParams.has('until')?{projects:[{id:'other',name:'Other'}]}:{projects:[{id:'project',name:'Project'}],pagination:{next:123}}};
    return {ok:true,json:async()=>({id:'project',accountId:'team',name:'Project'})};
  };
  const result=await selectSetupScope(connection,async(items,label)=>{clock=label==='Team'?200000:4000000;return items[0];},{now:()=>clock,oauthFactory,fetchImpl});
  assert.equal(result,connection);assert.equal(refreshes,2);
  assert.deepEqual(requests.map(x=>x.token),['Bearer original','Bearer token-1','Bearer token-1','Bearer token-2']);
  assert.equal(connection.refreshToken,'refresh-2');assert.equal(connection.expiresAt,7600000);
  assert.equal(connection.teamId,'team');assert.equal(connection.projectId,'project');assert.equal(connection.teamName,'Team');
});

test('initial setup refresh failure is actionable and never exposes provider errors or changes saved inputs', async()=>{
  const connection={type:'oauth',token:'old',refreshToken:'private-refresh',expiresAt:0};
  const before=structuredClone(connection);let calls=0;
  await assert.rejects(selectSetupScope(connection,async()=>{}, {now:()=>1,oauthFactory:async()=>({refreshToken:async()=>{throw new Error('private-provider-body');}}),fetchImpl:async()=>{calls++;}}),error=>{
    assert.match(error.message,/sign-in needs renewal.*setup/i);assert.doesNotMatch(error.message,/private/);return true;
  });
  assert.deepEqual(connection,before);assert.equal(calls,0);
});

test('API diagnostics retain status without provider bodies, credentials or misleading login-for-unsaved-host advice',async()=>{
  for(const status of [401,403,429,500]){
    let bodyRead=false;
    await assert.rejects(listChoices('private-token','team',async()=>({ok:false,status,json:async()=>{bodyRead=true;return {error:{message:'private-token'}};}})),error=>{
      assert.match(error.message,new RegExp('HTTP '+status));assert.doesNotMatch(error.message,/private-token|login for this host/);return true;
    });
    assert.equal(bodyRead,false);
  }
  await assert.rejects(listChoices('private-token',undefined,async()=>{throw new Error('private-token');}),error=>{
    assert.match(error.message,/Could not reach Vercel/);assert.doesNotMatch(error.message,/private-token/);return true;
  });
});
