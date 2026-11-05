import test from 'node:test';
import assert from 'node:assert/strict';
import { generateClientKeyPair } from '../src/keys.mjs';
import { requireSsh2 } from '../src/paths.mjs';

test('generated key material is validated before use and malformed library output is retried', async t => {
  const {utils}=requireSsh2();
  let valid;
  for(let i=0;i<16;i++){
    const pair=await new Promise((resolve,reject)=>utils.generateKeyPair('ed25519',(error,result)=>error?reject(error):resolve(result)));
    if(!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)){valid=pair;break;}
  }
  assert.ok(valid,'could not prepare a valid library key fixture');
  let calls=0;
  t.mock.method(utils,'generateKeyPair',(type,callback)=>{assert.equal(type,'ed25519');calls++;callback(null,calls===1?{private:'malformed fixture',public:valid.public}:calls===2?{private:valid.private,public:valid.private}:valid);});
  const result=await generateClientKeyPair();
  assert.equal(calls,3);assert.equal(result.privateKey,valid.private);
  assert.ok(utils.parseKey(result.privateKey).isPrivateKey());
});

test('repeated invalid key generation fails before exposing incomplete material', async t=>{
  const {utils}=requireSsh2();let calls=0;
  t.mock.method(utils,'generateKeyPair',(_,callback)=>{calls++;callback(null,{private:'private fixture',public:'public fixture'});});
  await assert.rejects(generateClientKeyPair(),/could not produce a valid key pair/i);
  assert.equal(calls,3);
});
