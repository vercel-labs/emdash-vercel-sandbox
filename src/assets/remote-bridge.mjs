import { createServer as httpServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

import { WebSocketServer, createWebSocketStream } from 'ws';

const tokenPath = '/vercel/sandbox/emdash-launcher/bridge-token';
const expected = Buffer.from(`Bearer ${readFileSync(tokenPath, 'utf8').trim()}`);
const server = httpServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404);
  response.end(request.url === '/health' ? 'emdash-sandbox-launcher\n' : '');
});
const websockets = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 2 * 1024 * 1024
});

server.on('upgrade', (request, socket, head) => {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  if (request.url !== '/ssh') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  websockets.handleUpgrade(request, socket, head, websocket => {
    const stream = createWebSocketStream(websocket);
    const ssh = createConnection({ host: '127.0.0.1', port: 2222 });
    const close = () => {
      ssh.destroy();
      stream.destroy();
      websocket.terminate();
    };
    ssh.on('error', close);
    stream.on('error', close);
    websocket.on('error', close);
    ssh.on('close', () => stream.destroy());
    stream.on('close', () => ssh.destroy());
    stream.pipe(ssh).pipe(stream);
  });
});

function stop() {
  for (const client of websockets.clients) client.terminate();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
server.listen(8080, '0.0.0.0', () => process.stdout.write('BRIDGE_READY\n'));
