import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSetupServer } from './setup-window-server.mjs';

export async function launchSetupWindow() {
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'--serve'],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
  const result=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Could not open setup. Try emdash-sandbox setup --terminal.'));},15000);
    child.once('message',message=>{clearTimeout(timer);resolve(message);});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Could not start the setup window.'));});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Setup window could not start.'));});
  });
  child.disconnect();child.unref();
  if(result.error)throw new Error('Could not open a browser. Use emdash-sandbox setup --terminal.');
  process.stdout.write('Vercel host setup opened in your browser. You can close this terminal.\n');
}

if(process.argv[1]===fileURLToPath(import.meta.url)&&process.argv[2]==='--serve'){
  try {
    const app=await createSetupServer();
    const opener=spawn(process.platform==='darwin'?'open':'xdg-open',[app.url],{stdio:'ignore'});
    opener.once('error',async()=>{process.send?.({error:true});await app.close();});
    opener.once('exit',async code=>{if(code!==0){process.send?.({error:true});await app.close();}else process.send?.({ready:true});});
  }catch{process.send?.({error:true});process.exitCode=1;}
}
