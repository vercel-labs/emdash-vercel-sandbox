import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { redactResolvedCredentials } from './credentials.mjs';
import { assetPath, requireSsh2 } from './paths.mjs';
import { generateClientKeyPair } from './keys.mjs';
import { prepareRepository } from './repository.mjs';
import { deleteOwnedSandbox, getSandbox, isNotFoundError, ownershipTags } from './sandbox.mjs';
import { writePrivateFile, writeStateAtomically, removeStateArtifacts, readFileSyncPrivate } from './state.mjs';
import { waitForBridge } from './transport.mjs';

const REMOTE_ROOT = '/vercel/sandbox/emdash-launcher';

export async function runRemote(sandbox, label, params, resolved = {}) {
  const result = await sandbox.runCommand({timeoutMs:240000, ...params});
  if (resolved.stateDir) {
    const stdout = redactResolvedCredentials(await result.stdout(), resolved);
    const stderr = redactResolvedCredentials(await result.stderr(), resolved);
    await writePrivateFile(path.join(resolved.stateDir, 'receipts', 'command-'+randomUUID()+'.json'),
      JSON.stringify({ label, commandId: result.cmdId ?? null, exitCode: result.exitCode,
        at: new Date().toISOString(), stdout, stderr,
        stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
        stderrSha256: createHash('sha256').update(stderr).digest('hex') }, null, 2)+'\n');
  }
  if (result.exitCode !== 0) {
    const diagnostic = redactResolvedCredentials((await result.stderr()).slice(-8000), resolved);
    throw new Error(label + ' failed (exit ' + result.exitCode + '): '+diagnostic);
  }
  return { stdout: await result.stdout(), stderr: await result.stderr() };
}

async function readHostKey(sandbox, resolved) {
  const result = await runRemote(sandbox, 'Read host identity', {cmd:'cat',args:['/etc/ssh/ssh_host_ed25519_key.pub']}, resolved);
  const key = result.stdout.trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+=*( .*)?$/.test(key)) throw new Error('Invalid host public key');
  return key;
}

async function uploadRuntime(sandbox, state, stateDir, repository) {
  const files = [];
  for (const name of ['bootstrap.sh','ensure-runtime.sh','remote-bridge.mjs','runtime-env.sh','bootstrap-project.py','publish-export.py']) {
    files.push({path:REMOTE_ROOT+'/'+name,content:await fsp.readFile(assetPath(name)),mode:0o600});
  }
  files.push({path:REMOTE_ROOT+'/client.pub',content:await fsp.readFile(path.join(stateDir,'id_ed25519.pub')),mode:0o600});
  files.push({path:REMOTE_ROOT+'/bridge-token',content:state.bridgeToken,mode:0o600});
  if (repository) files.push({path:REMOTE_ROOT+'/repository.bundle',content:repository.bundle,mode:0o600});
  await sandbox.writeFiles(files);
}

export async function startServices(sandbox, resolved, waitReady = waitForBridge) {
  await runRemote(sandbox,'Start runtime',{cmd:'bash',args:[REMOTE_ROOT+'/ensure-runtime.sh'],sudo:true}, resolved);
  const check = await runRemote(sandbox, 'Probe bridge port', {cmd:'python3',args:['-c',"import socket; s=socket.socket(); s.settimeout(1); print(s.connect_ex(('127.0.0.1',8080))); s.close()"]}, resolved);
  let bridge;
  const receipt = async (phase, diagnostic = '') => {
    if (!resolved.stateDir) return;
    await writePrivateFile(path.join(resolved.stateDir, 'receipts', 'bridge-'+randomUUID()+'.json'),
      JSON.stringify({label:'Start bridge', phase, commandId:bridge?.cmdId ?? null,
        at:new Date().toISOString(), diagnostic}, null, 2)+'\n');
  };
  try {
    if (check.stdout.trim() !== '0') {
      bridge = await sandbox.runCommand({cmd:'node',args:[REMOTE_ROOT+'/remote-bridge.mjs'],detached:true});
      await receipt('launched');
    }
    await waitReady(sandbox.domain(8080));
    await receipt('ready');
  } catch (error) {
    let output = '', logs;
    try {
      if (bridge) {
        logs = bridge.logs({signal:AbortSignal.timeout(1500)});
        for await (const entry of logs) {
          output += entry.data;
          if (output.length >= 16000) break;
        }
      }
    } catch (logError) { output += '\nLog collection: ' + logError.message; }
    finally { logs?.close(); }
    const diagnostic = redactResolvedCredentials(error.message + '\n' + output, resolved).slice(-8000);
    await receipt('failed', diagnostic);
    throw new Error('Start bridge failed' + (bridge ? ' (command ' + bridge.cmdId + ')' : '') + ': ' + diagnostic);
  }
}

export async function createSandbox({stateDir,credentials,name,timeoutMinutes,keyPair,relayPort,repositoryPath,hostName}) {
  const entries=await fsp.readdir(stateDir);
  if(entries.some(x=>!['receipts','.launcher.lock'].includes(x))) throw new Error('Create requires an empty private state directory');
  for(const file of ['bootstrap.sh','ensure-runtime.sh','remote-bridge.mjs','runtime-env.sh','bootstrap-project.py','publish-export.py']) await fsp.access(assetPath(file));
  const repository=repositoryPath ? await prepareRepository(repositoryPath) : null;
  try { await Sandbox.get({name,resume:false,...credentials,signal:AbortSignal.timeout(30000)}); throw new Error('Sandbox name already exists'); }
  catch(error) { if(!isNotFoundError(error)) throw error; }
  const state={schemaVersion:'1',id:keyPair.stateId,name,teamId:credentials.teamId,projectId:credentials.projectId,
    bridgeToken:keyPair.bridgeToken,url:'',hostPublicKey:'',status:'creating',relayPort,
    timeoutMs:timeoutMinutes*60000,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
    setupPhase:'preparing', repositorySource:repositoryPath ? path.resolve(repositoryPath) : null,
    imported:repository ? {branch:repository.branch,head:repository.head,sha256:repository.sha256} : null};
  await writeStateAtomically(stateDir,state);
  await writePrivateFile(path.join(stateDir,'id_ed25519'),keyPair.privateKey);
  await writePrivateFile(path.join(stateDir,'id_ed25519.pub'),keyPair.publicKey+'\n');
  await writePrivateFile(path.join(stateDir,'bridge-token'),keyPair.bridgeToken);
  if(repository) await writePrivateFile(path.join(stateDir,'repository.bundle'),repository.bundle);
  return continueCreateSandbox(stateDir,state,credentials,{hostName});
}

export async function continueCreateSandbox(stateDir,state,credentials,{hostName}={}) {
  if(hostName && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(hostName)) throw new Error('Invalid recovery host name');
  if(!['preparing','allocating','provisioning'].includes(state.setupPhase)) throw new Error('This host has no resumable setup record; preserve its state for recovery');
  if(state.teamId!==credentials.teamId || state.projectId!==credentials.projectId) throw new Error('Credential scope differs from launcher state');
  const resolved={stateDir,token:credentials.token,bridgeToken:state.bridgeToken};
  const exists = file => fsp.lstat(path.join(stateDir,file)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  try {
    if(state.setupPhase==='preparing') {
      if(!await exists('id_ed25519')) {
        if(await exists('id_ed25519.pub')) throw new Error('Setup key files are inconsistent; preserve them for investigation');
        const keys=await generateClientKeyPair();
        await writePrivateFile(path.join(stateDir,'id_ed25519'),keys.privateKey);
        await writePrivateFile(path.join(stateDir,'id_ed25519.pub'),keys.publicKey+'\n');
      }
      if(!await exists('id_ed25519.pub')) {
        const parsed=requireSsh2().utils.parseKey(readFileSyncPrivate(path.join(stateDir,'id_ed25519')));
        if(parsed instanceof Error || !parsed.isPrivateKey()) throw new Error('Saved setup key is invalid');
        await writePrivateFile(path.join(stateDir,'id_ed25519.pub'),'ssh-ed25519 '+parsed.getPublicSSH().toString('base64')+'\n');
      }
      if(!await exists('bridge-token')) await writePrivateFile(path.join(stateDir,'bridge-token'),state.bridgeToken);
      if(state.imported && !await exists('repository.bundle')) {
        const recovered=await prepareRepository(state.repositorySource);
        if(recovered.head!==state.imported.head || recovered.branch!==state.imported.branch || recovered.sha256!==state.imported.sha256) throw new Error('Source repository changed since setup; restore the original checkout before retrying');
        await writePrivateFile(path.join(stateDir,'repository.bundle'),recovered.bundle);
      }
      state.setupPhase='allocating';
      await writeStateAtomically(stateDir,state);
    }
    for(const file of ['id_ed25519','id_ed25519.pub','bridge-token']) readFileSyncPrivate(path.join(stateDir,file));
    let repository=null;
    if(state.imported) {
      const bundle=readFileSyncPrivate(path.join(stateDir,'repository.bundle'));
      if(bundle.length>32*1024*1024 || createHash('sha256').update(bundle).digest('hex')!==state.imported.sha256) throw new Error('Saved repository bundle changed; refusing to provision');
      repository={...state.imported,bundle};
    }
    let sandbox;
    try { sandbox=await getSandbox(state,credentials,{resume:false,signal:AbortSignal.timeout(30000)}); }
    catch(error) {
      if(!isNotFoundError(error)) throw error;
      if(state.sessionId) throw new Error('Previously allocated host is missing; setup will not replace it');
      // Names are unique within the project. Retries retain this name and ownership ID.
      sandbox=await Sandbox.create({name:state.name,...credentials,image:'vercel/sandbox/universal',resources:{vcpus:2},
        timeout:state.timeoutMs,ports:[8080],persistent:true,snapshotExpiration:86400000,
        keepLastSnapshots:{count:2,expiration:86400000},tags:ownershipTags(state.id),signal:AbortSignal.timeout(60000)});
    }
    if(sandbox.status!=='running') sandbox=await getSandbox(state,credentials,{resume:true,signal:AbortSignal.timeout(60000)});
    state.sessionId=sandbox.currentSession().sessionId;state.setupPhase='provisioning';
    await writeStateAtomically(stateDir,state);
    if(state.hostPublicKey && await readHostKey(sandbox,resolved)!==state.hostPublicKey) throw new Error('SSH host identity mismatch; refusing to repin');
    await uploadRuntime(sandbox,state,stateDir,repository);
    await runRemote(sandbox,'Install remote dependencies',{cmd:'bash',args:[REMOTE_ROOT+'/bootstrap.sh',...(repository ? [repository.branch,repository.head,repository.sha256] : [])],sudo:true},resolved);
    state.hostPublicKey=await readHostKey(sandbox,resolved);state.url=sandbox.domain(8080);
    await startServices(sandbox,resolved);
    state.status='running';state.setupPhase='ready';state.updatedAt=new Date().toISOString();
    await writeStateAtomically(stateDir,state);
    return {name:state.name,status:state.status,project:'/home/emdash/project',relayPort:state.relayPort,
      ...(state.imported ? {imported:state.imported} : {})};
  } catch(error) {
    const failures=['Create failed: '+redactResolvedCredentials(error instanceof Error ? error.message : String(error),resolved)];
    try { state.status='failed';state.updatedAt=new Date().toISOString();await writeStateAtomically(stateDir,state); }
    catch(stateError) { failures.push('Failed to mark state as failed: '+stateError.message); }
    failures.push('The original host identity, credentials and state are retained as reproduction evidence.');
    failures.push('Run setup with the same host name to continue. No replacement name will be allocated.');
    const quotedStateDir = "'" + path.resolve(stateDir).replaceAll("'", "'\\''") + "'";
    failures.push('Check recovery with: emdash-sandbox status ' + (hostName ? '--host ' + hostName : '--state-dir ' + quotedStateDir));
    throw new Error(failures.join('\n'));
  }
}

export async function resumeSandbox(stateDir,state,credentials) {
  const resolved={stateDir,token:credentials.token,bridgeToken:state.bridgeToken};
  let sandbox=await getSandbox(state,credentials,{resume:false,signal:AbortSignal.timeout(30000)});
  const before=sandbox.currentSession().sessionId;
  let resumed=false;
  try {
    if(sandbox.status !== 'running') {
      sandbox=await getSandbox(state,credentials,{resume:true,signal:AbortSignal.timeout(60000)});
      resumed=true;
    }
    const accounting={...state,status:sandbox.status,url:sandbox.domain(8080),
      sessionId:sandbox.currentSession().sessionId,updatedAt:new Date().toISOString()};
    if(resumed) await writeStateAtomically(stateDir,accounting);
    if(await readHostKey(sandbox,resolved)!==state.hostPublicKey) throw new Error('SSH host identity mismatch; refusing to repin');
    await startServices(sandbox,resolved);
    const next={...state,status:'running',url:sandbox.domain(8080),sessionId:sandbox.currentSession().sessionId,updatedAt:new Date().toISOString()};
    await writeStateAtomically(stateDir,next);
    return {name:state.name,status:next.status,previousSessionId:before,sessionId:next.sessionId,restoredProcesses:false};
  } catch(error) {
    const original=redactResolvedCredentials(error instanceof Error ? error.message : String(error), resolved);
    const failures=['Resume failed: '+original];
    try {
      await writeStateAtomically(stateDir,{...state,status:'failed',url:sandbox.domain(8080),
        sessionId:sandbox.currentSession().sessionId,updatedAt:new Date().toISOString()});
    } catch (stateError) {
      failures.push('Failed to update state after resume failure: '+stateError.message);
    }
    failures.push('The VM may be running; check it with status before retrying or destroying.');
    throw new Error(failures.join('\n'));
  }
}

export async function stopSandbox(stateDir,state,credentials) {
  const sandbox=await getSandbox(state,credentials,{resume:false,signal:AbortSignal.timeout(30000)});
  try {
    if(sandbox.status==='running') await sandbox.stop({signal:AbortSignal.timeout(60000)});
  } catch(error) {
    throw new Error('Stop failed: '+redactResolvedCredentials(error.message,{token:credentials.token,bridgeToken:state.bridgeToken})+'; private state is retained');
  }
  await writeStateAtomically(stateDir,{...state,status:sandbox.status,updatedAt:new Date().toISOString()});
  return {name:state.name,status:sandbox.status};
}

export async function destroySandbox(stateDir,state,credentials) {
  let result;
  try {
    result=await deleteOwnedSandbox(state,credentials,AbortSignal.timeout(120000));
  } catch(error) {
    throw new Error('Destroy failed: '+redactResolvedCredentials(error.message,{token:credentials.token,bridgeToken:state.bridgeToken})+
      '; the host and private state are retained. Retry destroy after resolving the failure.');
  }
  try {
    await removeStateArtifacts(stateDir);
  } catch(cleanupError) {
    throw new Error('Destroy removed the host, but local cleanup failed: '+cleanupError.message+
      '; private state is retained. Retry destroy after resolving the failure.');
  }
  return {name:state.name,...result};
}

export async function statusSandbox(state,credentials) {
  const sandbox=await getSandbox(state,credentials,{resume:false,signal:AbortSignal.timeout(30000)});
  return {name:sandbox.name,status:sandbox.status,persistent:sandbox.persistent,sessionId:sandbox.currentSession().sessionId,
    expiresAt:sandbox.expiresAt?.toISOString()??null,relayPort:state.relayPort};
}
