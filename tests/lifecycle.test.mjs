import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sandbox, APIError } from '@vercel/sandbox';
import { createSandbox, continueCreateSandbox, resumeSandbox, startServices } from '../src/lifecycle.mjs';
import { ensurePrivateStateDir, readState, writeStateAtomically } from '../src/state.mjs';
import { ownershipTags } from '../src/sandbox.mjs';

const remoteRoot = '/vercel/sandbox/emdash-launcher';
const hostKey = 'ssh-ed25519 YWJj fixture';
const credentials = { token: 'fixture-control-token', teamId: 'team', projectId: 'project' };
const keyPair = { stateId: 'fixture-state', bridgeToken: 'fixture-bridge-token', privateKey: 'fixture-private', publicKey: 'ssh-ed25519 ZGVm fixture' };
const finished = (stdout = '', stderr = '', exitCode = 0) => ({ stdout: async () => stdout, stderr: async () => stderr, exitCode });
async function setup(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'emdash-lifecycle-'));
  await ensurePrivateStateDir(dir);
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const old = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = 'fixture-gateway-token';
  t.after(() => { if (old === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = old; });
  return dir;
}
function fakeSandbox() {
  return { status: 'running', tags: ownershipTags(keyPair.stateId), currentSession: () => ({ sessionId: 'session-new' }), domain: () => 'https://fixture.invalid', writeFiles: async () => {}, runCommand: async () => finished(), delete: async () => { throw new Error('Unexpected deletion of failure evidence'); } };
}

for (const modelKey of [undefined, 'ambient-model-secret']) {
  test(`create is agent-independent with ${modelKey ? 'an ambient' : 'no'} model key`, async t => {
    const stateDir = await setup(t), remote = new Map(), commands = [];
    if (modelKey) process.env.AI_GATEWAY_API_KEY = modelKey;
    else delete process.env.AI_GATEWAY_API_KEY;
    const sandbox = fakeSandbox();
    sandbox.writeFiles = async files => { for (const f of files) remote.set(f.path, Buffer.from(f.content).toString()); };
    sandbox.runCommand = async params => {
      commands.push(params);
      if (params.args?.[0] === remoteRoot + '/bootstrap.sh') {
        assert.equal(remote.get(remoteRoot + '/client.pub'), keyPair.publicKey + '\n');
        assert.equal(remote.get(remoteRoot + '/bridge-token'), keyPair.bridgeToken);
      }
      if (params.cmd === 'cat') return finished(hostKey + '\n');
      if (params.cmd === 'python3') return finished('0\n');
      return finished();
    };
    t.mock.method(Sandbox, 'get', async () => { throw new APIError(new Response('', { status: 404 })); });
    t.mock.method(Sandbox, 'create', async () => sandbox);
    t.mock.method(globalThis, 'fetch', async () => new Response('emdash-sandbox-launcher'));
    const result = await createSandbox({ stateDir, credentials, name: 'fixture', timeoutMinutes: 5, keyPair, relayPort: 22421 });
    assert.equal(result.status, 'running');
    assert.equal((await readState(stateDir)).sessionId, 'session-new');
    assert.deepEqual([...remote.keys()].sort(), ['bootstrap.sh','ensure-runtime.sh','remote-bridge.mjs','runtime-env.sh','bootstrap-project.py','publish-export.py','client.pub','bridge-token'].map(n => remoteRoot + '/' + n).sort());
    assert.equal(commands.some(p => JSON.stringify(p).includes('install-agent')), false);
    if (modelKey) assert.equal([...remote.values()].some(v => v.includes(modelKey)), false);
  });
}

test('failed setup preserves owned resource identity and private state without leaking credentials', async t => {
  const stateDir = await setup(t), sandbox = fakeSandbox();
  sandbox.runCommand = async () => finished('', `${credentials.token} ${keyPair.bridgeToken} ${process.env.AI_GATEWAY_API_KEY}`, 17);
  t.mock.method(Sandbox, 'get', async () => { throw new APIError(new Response('', { status: 404 })); });
  t.mock.method(Sandbox, 'create', async () => sandbox);
  await assert.rejects(createSandbox({ stateDir, credentials, name: 'fixture', timeoutMinutes: 5, keyPair, relayPort: 22421 }), error => {
    assert.match(error.message, /exit 17/);
    assert.match(error.message, /retained/);
    for (const secret of [credentials.token, keyPair.bridgeToken, process.env.AI_GATEWAY_API_KEY]) assert.equal(error.message.includes(secret), false);
    return true;
  });
  const state = await readState(stateDir);
  assert.equal(state.status, 'failed');
  assert.equal(state.sessionId, 'session-new');
  assert.equal(await fsp.readFile(path.join(stateDir, 'id_ed25519'), 'utf8'), keyPair.privateKey);
});

test('resume with a changed host key records the new session, rejects connection and keeps the pin', async t => {
  const stateDir = await setup(t);
  const state = { schemaVersion: '1', id: keyPair.stateId, name: 'fixture', teamId: credentials.teamId, projectId: credentials.projectId, bridgeToken: keyPair.bridgeToken, relayPort: 22421, hostPublicKey: hostKey, url: 'https://fixture.invalid', status: 'stopped', sessionId: 'session-old' };
  await writeStateAtomically(stateDir, state);
  const old = { ...fakeSandbox(), status: 'stopped', currentSession: () => ({ sessionId: 'session-old' }) };
  const resumed = fakeSandbox();
  resumed.runCommand = async params => { assert.equal(params.cmd, 'cat'); return finished('ssh-ed25519 Z2hp changed\n'); };
  t.mock.method(Sandbox, 'get', async params => params.resume ? resumed : old);
  await assert.rejects(resumeSandbox(stateDir, state, credentials), /identity mismatch/);
  const actual = await readState(stateDir);
  assert.equal(actual.sessionId, 'session-new');
  assert.equal(actual.hostPublicKey, hostKey);
  assert.equal(actual.status, 'failed');
});


test('failed bridge readiness retains command ID and redacted startup diagnostic', async t => {
  const stateDir = await setup(t), sandbox = fakeSandbox();
  let closed = false;
  sandbox.runCommand = async params => {
    if (!params.detached) return finished('111\n');
    return {cmdId: 'bridge-fixture', logs: () => {
      const logs = (async function* () {
        yield {stream:'stderr', data: 'Cannot start bridge: ' + credentials.token + ' ' + keyPair.bridgeToken + ' ' + process.env.AI_GATEWAY_API_KEY};
      })();
      logs.close = () => { closed = true; };
      return logs;
    }};
  };
  await assert.rejects(startServices(sandbox, {stateDir, token:credentials.token, bridgeToken:keyPair.bridgeToken}, async () => {
    const receipts = await Promise.all((await fsp.readdir(path.join(stateDir,'receipts'))).map(name => fsp.readFile(path.join(stateDir,'receipts',name),'utf8')));
    assert.ok(receipts.some(value => JSON.parse(value).commandId === 'bridge-fixture'));
    throw new Error('Sandbox bridge did not become ready');
  }), error => {
    assert.match(error.message, /bridge-fixture/);
    assert.match(error.message, /Cannot start bridge/);
    for (const secret of [credentials.token, keyPair.bridgeToken, process.env.AI_GATEWAY_API_KEY]) assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(closed,true);
  const records = await Promise.all((await fsp.readdir(path.join(stateDir,'receipts'))).map(async name => JSON.parse(await fsp.readFile(path.join(stateDir,'receipts',name),'utf8'))));
  assert.equal(records.find(r => r.phase === 'failed').diagnostic.includes('Cannot start bridge'), true);
  for (const secret of [credentials.token, keyPair.bridgeToken, process.env.AI_GATEWAY_API_KEY]) assert.equal(JSON.stringify(records).includes(secret), false);
});

test('healthy detached bridge never waits for command completion or output', async t => {
  const stateDir = await setup(t), sandbox = fakeSandbox();
  sandbox.runCommand = async params => params.detached ? {
    cmdId:'healthy-bridge',
    logs: () => { throw new Error('Healthy bridge logs must not be drained'); },
    stdout: () => { throw new Error('Healthy bridge output must not be awaited'); },
    wait: () => { throw new Error('Healthy bridge must not be waited on'); },
  } : finished('111\n');
  await startServices(sandbox, {stateDir}, async () => {});
  const records = await Promise.all((await fsp.readdir(path.join(stateDir,'receipts'))).map(async name => JSON.parse(await fsp.readFile(path.join(stateDir,'receipts',name),'utf8'))));
  assert.ok(records.some(r => r.phase === 'ready' && r.commandId === 'healthy-bridge'));
});


test('invalid repository is rejected before any Sandbox API allocation', async t => {
  const stateDir = await setup(t);
  t.mock.method(Sandbox, 'get', async () => { assert.fail('No API lookup before repository validation'); });
  t.mock.method(Sandbox, 'create', async () => { assert.fail('No provisioning before repository validation'); });
  await assert.rejects(createSandbox({stateDir,credentials,name:'fixture',timeoutMinutes:5,keyPair,relayPort:22421,repositoryPath:stateDir}), /checkout root/);
  await assert.rejects(readState(stateDir));
});


test('setup retry after an allocation error retains its name, ownership and keys', async t => {
  const stateDir = await setup(t), sandbox = fakeSandbox();
  const allocations = [];
  sandbox.runCommand = async params => params.cmd === 'cat' ? finished(hostKey + '\n') : params.cmd === 'python3' ? finished('0\n') : finished();
  t.mock.method(Sandbox, 'get', async () => { throw new APIError(new Response('', { status: 404 })); });
  t.mock.method(Sandbox, 'create', async params => { allocations.push(params); if (allocations.length === 1) throw new Error('interrupted before allocation'); return sandbox; });
  t.mock.method(globalThis, 'fetch', async () => new Response('emdash-sandbox-launcher'));
  await assert.rejects(createSandbox({ stateDir, credentials, name: 'stable-name', timeoutMinutes: 5, keyPair, relayPort: 22421 }), /interrupted/);
  const original = await readState(stateDir);
  assert.equal(original.setupPhase, 'allocating'); assert.equal(original.sessionId, undefined);
  await continueCreateSandbox(stateDir, original, credentials);
  assert.equal(allocations.length, 2);
  assert.equal(allocations[0].name, allocations[1].name);
  assert.deepEqual(allocations[0].tags, allocations[1].tags);
  assert.equal(await fsp.readFile(path.join(stateDir, 'id_ed25519'), 'utf8'), keyPair.privateKey);
  assert.equal((await readState(stateDir)).setupPhase, 'ready');
});

test('lost allocation response reconciles owned host instead of allocating another', async t => {
  const stateDir = await setup(t), sandbox = fakeSandbox(); let allocated = false, creates = 0;
  sandbox.runCommand = async params => params.cmd === 'cat' ? finished(hostKey + '\n') : params.cmd === 'python3' ? finished('0\n') : finished();
  t.mock.method(Sandbox, 'get', async () => { if (allocated) return sandbox; throw new APIError(new Response('', { status: 404 })); });
  t.mock.method(Sandbox, 'create', async () => { creates++; allocated = true; throw new Error('lost response'); });
  t.mock.method(globalThis, 'fetch', async () => new Response('emdash-sandbox-launcher'));
  await assert.rejects(createSandbox({ stateDir, credentials, name: 'stable-name', timeoutMinutes: 5, keyPair, relayPort: 22421 }), /lost response/);
  await continueCreateSandbox(stateDir, await readState(stateDir), credentials);
  assert.equal(creates, 1); assert.equal((await readState(stateDir)).sessionId, 'session-new');
});

test('setup recovery refuses a foreign host and never replaces a missing known session', async t => {
  const stateDir = await setup(t);
  const state = { schemaVersion: '1', id: keyPair.stateId, name: 'fixture', teamId: 'team', projectId: 'project', bridgeToken: keyPair.bridgeToken, status: 'failed', setupPhase: 'allocating', relayPort: 22222, timeoutMs: 300000, hostPublicKey: '', url: '', sessionId: 'known-session' };
  for (const [file, data] of [['id_ed25519', keyPair.privateKey], ['id_ed25519.pub', keyPair.publicKey], ['bridge-token', keyPair.bridgeToken]]) await fsp.writeFile(path.join(stateDir, file), data, { mode: 0o600 });
  await writeStateAtomically(stateDir, state);
  t.mock.method(Sandbox, 'create', async () => assert.fail('must not replace missing or foreign host'));
  t.mock.method(Sandbox, 'get', async () => { throw new APIError(new Response('', { status: 404 })); });
  await assert.rejects(continueCreateSandbox(stateDir, state, credentials), /will not replace/);
  t.mock.method(Sandbox, 'get', async () => ({ ...fakeSandbox(), tags: ownershipTags('foreign') }));
  await assert.rejects(continueCreateSandbox(stateDir, state, credentials), /not owned/);
});


test('named setup failure gives a command that uses its saved OAuth connection', async t => {
  const stateDir = await setup(t);
  t.mock.method(Sandbox, 'get', async () => { throw new APIError(new Response('', { status: 404 })); });
  t.mock.method(Sandbox, 'create', async () => { throw new Error('allocation failed'); });
  await assert.rejects(createSandbox({ stateDir, credentials, name: 'cloud-name', hostName: 'browser-host', timeoutMinutes: 5, keyPair, relayPort: 22421 }), error => {
    assert.match(error.message, /emdash-sandbox status --host browser-host/);
    assert.doesNotMatch(error.message, /status --state-dir/);
    return true;
  });
});
