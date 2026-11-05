import { createServer as httpServer } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { once } from 'node:events';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { WebSocketServer, createWebSocketStream } from 'ws';
import { generateClientKeyPair } from '../../src/keys.mjs';

export async function fixture(t, { innerSsh = false, stallAuthentication = false } = {}) {
  const key=await generateClientKeyPair(),host=await generateClientKeyPair();
  const expected=utils.parseKey(key.publicKey).getPublicSSH();
  const echo=innerSsh ? new Server({hostKeys:[host.privateKey]}, conn => {
    conn.on('error',()=>{});
    conn.on('authentication',ctx=>{
      if(stallAuthentication) return;
      if(ctx.method==='publickey' && ctx.key.data.equals(expected) && (!ctx.signature || utils.parseKey(key.publicKey).verify(ctx.blob,ctx.signature,ctx.hashAlgo))) ctx.accept(); else ctx.reject();
    });
    conn.on('ready',()=>conn.on('session',accept=>accept().on('exec',accept=>{const channel=accept();channel.write('proxy-command-ok\n');channel.exit(0);channel.end();})));
  }) : createServer(s=>s.pipe(s));echo.listen(0,'127.0.0.1');await once(echo,'listening');
  let forwarded=0;
  const ssh=new Server({hostKeys:[host.privateKey]},conn=>{
    conn.on('error',()=>{});
    conn.on('authentication',ctx=>{
      if(stallAuthentication) return;
      if(ctx.method==='publickey'&&ctx.key.data.equals(expected)){
        const parsed=utils.parseKey(key.publicKey);
        if(!ctx.signature||parsed.verify(ctx.blob,ctx.signature,ctx.hashAlgo))ctx.accept();else ctx.reject();
      }else ctx.reject();
    }).on('tcpip',(accept,reject,info)=>{
      forwarded++;
      const stream=accept(),socket=createConnection({host:'127.0.0.1',port:echo.address().port});
      stream.on('error',()=>socket.destroy());socket.on('error',()=>stream.destroy());
      stream.on('close',()=>socket.destroy());socket.on('close',()=>stream.destroy());
      stream.pipe(socket).pipe(stream);
    });
  });
  ssh.listen(0,'127.0.0.1');await once(ssh,'listening');
  const http=httpServer(),wss=new WebSocketServer({noServer:true});
  http.on('upgrade',(req,socket,head)=>{
    if(req.headers.authorization!=='Bearer test-token'){socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');return;}
    wss.handleUpgrade(req,socket,head,ws=>{
      const stream=createWebSocketStream(ws),tcp=createConnection({host:'127.0.0.1',port:ssh.address().port});
      ws.on('error',()=>{});stream.on('error',()=>tcp.destroy());tcp.on('error',()=>stream.destroy());
      stream.on('close',()=>tcp.destroy());tcp.on('close',()=>stream.destroy());
      stream.pipe(tcp).pipe(stream);
    });
  });
  http.listen(0,'127.0.0.1');await once(http,'listening');
  t.after(()=>{for(const ws of wss.clients)ws.terminate();wss.close();http.close();ssh.close();echo.close();});
  return {options:{bridgeUrl:'http://127.0.0.1:'+http.address().port,bridgeToken:'test-token',hostPublicKey:host.publicKey,privateKey:key.privateKey,port:0},
    wss,forwarded:()=>forwarded};
}
