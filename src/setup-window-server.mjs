import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createController } from './setup-window-controller.mjs';

export async function createSetupServer({ controller = createController(), idleMs = 30 * 60 * 1000 } = {}) {
  const capability = randomBytes(32).toString('hex');
  let origin, lastActivity=Date.now();
  const assets=new Map([['/',['setup-window.html','text/html']],['/setup-window.css',['setup-window.css','text/css']],['/setup-window.mjs',['setup-window.mjs','text/javascript']],['/setup-presentation.mjs',['setup-presentation.mjs','text/javascript']]]);
  const server=http.createServer(async(req,res)=>{
    const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"};
    const send=(status,value,type='application/json')=>{res.writeHead(status,{...headers,'content-type':type});res.end(type==='application/json'?JSON.stringify(value):value);};
    if(req.headers.host!==new URL(origin).host || (req.headers.origin && req.headers.origin!==origin) || req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Open the setup window from its launcher.'});
    const route=new URL(req.url,origin).pathname;
    if(req.method==='GET'&&assets.has(route)) {
      const [file,type]=assets.get(route);
      try{return send(200,await readFile(new URL('./assets/'+file,import.meta.url)),type);}catch{return send(500,{error:'Setup files are missing. Reinstall the launcher.'});}
    }
    if(req.headers.authorization!=='Bearer '+capability)return send(403,{error:'Reopen the setup window to continue.'});
    lastActivity=Date.now();
    try {
      if(req.method==='GET'&&route==='/api/state')return send(200,await controller.state());
      if(req.method!=='POST'||!['login','teams','projects','create','host','close'].some(x=>route==='/api/'+x))return send(404,{error:'Unknown setup action.'});
      if(req.headers['content-type']!=='application/json')return send(415,{error:'Expected JSON.'});
      let body='',size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384){send(413,{error:'Request too large.'});return;}body+=chunk;}
      let data;try{data=JSON.parse(body);}catch{return send(400,{error:'Invalid request.'});}
      if(!data||Array.isArray(data)||typeof data!=='object')return send(400,{error:'Invalid request.'});
      if(route==='/api/close'){if(controller.busy())return send(409,{error:'Wait for the current operation to finish.'});send(200,{closed:true});setTimeout(()=>server.close(),100);return;}
      const result=await controller.dispatch(route.slice(5),data);
      return send(result.accepted?202:200,result);
    } catch(error){return send(controller.busy()?409:400,{error:controller.safeError?.(error)??'Setup could not complete this step.'});}
  });
  server.requestTimeout=20000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  const idle=setInterval(()=>{if(!controller.busy()&&Date.now()-lastActivity>idleMs)server.close();},30000);idle.unref();
  server.on('close',()=>clearInterval(idle));
  return { origin, capability, url:origin+'/#'+capability, close:()=>new Promise(resolve=>server.close(resolve)), server };
}
