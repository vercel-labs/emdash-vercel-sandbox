import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { generateClientKeyPair } from '../src/keys.mjs';
import { startForegroundRelay } from '../src/transport.mjs';
import { runStdioProxy } from '../src/proxy.mjs';
import { fixture } from './fixtures/ssh.mjs';
async function roundTrip(port) {
  const socket=createConnection({host:'127.0.0.1',port});
  const payload=Buffer.alloc(256*1024);for(let i=0;i<payload.length;i++)payload[i]=i%251;
  return new Promise((resolve,reject)=>{
    let got=Buffer.alloc(0);
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('round trip timeout'));},5000);
    socket.on('error',reject);socket.on('connect',()=>socket.write(payload));
    socket.on('data',data=>{got=Buffer.concat([got,data]);if(got.length===payload.length){clearTimeout(timer);socket.destroy();assert.deepEqual(got,payload);resolve();}});
  });
}
test('verified relay preserves binary bytes and reconnects on the same port after transport loss',{timeout:20000},async t=>{
  const f=await fixture(t),relay=await startForegroundRelay(f.options);t.after(()=>relay.stop());
  await roundTrip(relay.port);
  for(const ws of f.wss.clients)ws.terminate();
  await roundTrip(relay.port);
  assert.equal(f.forwarded(),2);
  relay.stop();await relay.closed;
});
test('wrong host identity forwards no desktop bytes',{timeout:20000},async t=>{
  const f=await fixture(t),wrong=await generateClientKeyPair();
  await assert.rejects(startForegroundRelay({...f.options,hostPublicKey:wrong.publicKey}),/identity mismatch/);
  assert.equal(f.forwarded(),0);
});
test('wrong bridge credential fails without an unhandled transport error',{timeout:20000},async t=>{
  const f=await fixture(t);
  await assert.rejects(startForegroundRelay({...f.options,bridgeToken:'wrong'}),/authentication failed/);
  assert.equal(f.forwarded(),0);
});


test('on-demand stdio proxy preserves binary bytes and releases connection when its caller exits', { timeout: 20000 }, async t => {
  const f = await fixture(t), input = new PassThrough(), output = new PassThrough();
  const bytes = Buffer.alloc(256 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  let received = Buffer.alloc(0), resolveReceived;
  const receivedAll = new Promise(resolve => { resolveReceived = resolve; });
  output.on('data', chunk => { received = Buffer.concat([received, chunk]); if (received.length >= bytes.length) resolveReceived(); });
  const done = runStdioProxy(f.options, { input, output });
  input.write(bytes);
  await receivedAll;
  assert.deepEqual(received, bytes); assert.equal(f.forwarded(), 1);
  input.end(); await done;
  assert.equal(input.listenerCount('end'), 0);
});

test('on-demand stdio proxy emits no stdout on host identity mismatch', { timeout: 20000 }, async t => {
  const f = await fixture(t), wrong = await generateClientKeyPair();
  const input = new PassThrough(), output = new PassThrough(); let received = 0;
  output.on('data', chunk => { received += chunk.length; });
  input.write('desktop bytes');
  await assert.rejects(runStdioProxy({ ...f.options, hostPublicKey: wrong.publicKey }, { input, output }), /identity mismatch/);
  assert.equal(f.forwarded(), 0); assert.equal(received, 0);
});


test('caller EOF aborts pending SSH authentication without leaving the proxy alive', { timeout: 3000 }, async t => {
  const f = await fixture(t, { stallAuthentication: true });
  const input = new PassThrough(), output = new PassThrough();
  const start = Date.now();
  const done = runStdioProxy(f.options, { input, output });
  input.write('SSH-2.0-caller\r\n');
  setTimeout(() => input.end(), 30);
  await done;
  assert.ok(Date.now() - start < 1000, 'pending authentication must not outlive caller by a second');
  assert.equal(f.forwarded(), 0);
  assert.equal(input.listenerCount('data'), 0);
});
