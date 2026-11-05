import { runHostCli, hostHelp } from './host-cli.mjs';
import path from 'node:path';
import { resolveCredentials } from './credentials.mjs';
import { generateClientKeyPair } from './keys.mjs';
import { createSandbox, destroySandbox, resumeSandbox, statusSandbox, stopSandbox } from './lifecycle.mjs';
import { ensurePrivateStateDir, readState, readFileSyncPrivate, recoverStateLock, withStateLock } from './state.mjs';
import { startForegroundRelay } from './transport.mjs';
import { validateSandboxName } from './validate.mjs';

const usage = 'Usage: emdash-sandbox <create|connect|status|export|stop|resume|destroy|recover-lock> --state-dir <absolute-dir>\n' +
'create: --name <unique-name> [--port 22222] [--timeout-minutes 90] [--repo <local-checkout>]\n' +
'export: --destination <new-directory> [--worktree <absolute-remote-worktree>]\n' +
'recover-lock: --lock-hash <sha256-from-lock-error> --lock-inode <inode-from-lock-error>\n' +
'connect: keep this terminal running; Emdash uses the printed localhost SSH settings.\n';

export async function runCli(argv) {
  if (!argv.length || ['--help','help'].includes(argv[0])) { process.stdout.write(hostHelp + '\nAdvanced state-directory commands:\n' + usage); return; }
  if (argv[0] === 'setup' && argv.length === 1) { const { launchSetupWindow } = await import('./setup-window.mjs'); return launchSetupWindow(); }
  if (argv[0] === 'setup' && argv.includes('--terminal')) { argv = argv.filter(value => value !== '--terminal'); }
  if (['setup','hosts','proxy','start','tasks','login','register'].includes(argv[0]) || argv.includes('--host')) return runHostCli(argv);
  const [command,...rest]=argv;
  const allowed={create:['state-dir','name','port','timeout-minutes','repo'],connect:['state-dir'],status:['state-dir'],
    export:['state-dir','destination','worktree'],stop:['state-dir'],resume:['state-dir'],destroy:['state-dir'],
    'recover-lock':['state-dir','lock-hash','lock-inode']};
  if(!allowed[command]) throw new Error('Unknown command');
  const flags={};
  for(let i=0;i<rest.length;i+=2){
    const key=rest[i].replace(/^--/,'');
    if(!rest[i].startsWith('--')||!allowed[command].includes(key)||!rest[i+1]||rest[i+1].startsWith('--')||key in flags) throw new Error('Invalid or duplicate option: '+rest[i]);
    flags[key]=rest[i+1];
  }
  if(!flags['state-dir']) throw new Error('--state-dir is required');
  const stateDir=await ensurePrivateStateDir(flags['state-dir']);
  const print=result=>process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(command==='recover-lock'){
    if(!flags['lock-hash']||!flags['lock-inode']) throw new Error('recover-lock requires --lock-hash and --lock-inode');
    print(await recoverStateLock(stateDir,flags['lock-hash'],flags['lock-inode']));
    return;
  }
  const credentials=await resolveCredentials();
  if(command==='create'){
    if(!flags.name) throw new Error('--name is required');
    validateSandboxName(flags.name);
    const timeoutMinutes=Number(flags['timeout-minutes']??90),relayPort=Number(flags.port??22222);
    if(!Number.isInteger(timeoutMinutes)||timeoutMinutes<5||timeoutMinutes>90)throw new Error('Timeout must be 5–90 minutes');
    if(!Number.isInteger(relayPort)||relayPort<1024||relayPort>65535)throw new Error('Port must be 1024–65535');
    print(await withStateLock(stateDir,async()=>createSandbox({stateDir,credentials,name:flags.name,timeoutMinutes,relayPort,repositoryPath:flags.repo,keyPair:await generateClientKeyPair()})));
  } else if(['stop','resume','destroy'].includes(command)){
    print(await withStateLock(stateDir,async()=>{
      const state=await readState(stateDir);
      return ({stop:stopSandbox,resume:resumeSandbox,destroy:destroySandbox})[command](stateDir,state,credentials);
    }));
  } else {
    const state=await readState(stateDir),status=await statusSandbox(state,credentials);
    if(command==='status'){print(status);return;}
    if(status.status!=='running')throw new Error('Sandbox is '+status.status+'; run resume explicitly');
    const privateKey=readFileSyncPrivate(path.join(stateDir,'id_ed25519'));
    if(command==='export'){
      if(!flags.destination)throw new Error('--destination is required');
      const {exportProject}=await import('./export.mjs');
      print(await exportProject({state,stateDir,destination:flags.destination,worktreeName:flags.worktree,privateKey,credentials}));
    }else{
      const relay=await startForegroundRelay({bridgeUrl:state.url,bridgeToken:state.bridgeToken,hostPublicKey:state.hostPublicKey,
        privateKey,port:state.relayPort,onError:message=>process.stderr.write(message+'\n')});
      print({host:relay.host,port:relay.port,user:'emdash',privateKeyPath:path.join(stateDir,'id_ed25519'),project:'/home/emdash/project',pid:relay.pid});
      await relay.closed;
    }
  }
}
