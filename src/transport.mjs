import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { openVerifiedSsh } from './ssh-command.mjs';

export async function waitForBridge(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.text()).trim() === 'emdash-sandbox-launcher') return;
    } catch {}
    await delay(300);
  }
  throw new Error('Sandbox bridge did not become ready');
}

export async function startForegroundRelay(options) {
  const probe = await openVerifiedSsh(options);
  probe.close();
  const sockets = new Set(), connections = new Set();
  let stopping = false, resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = createServer(async socket => {
    sockets.add(socket);
    let connection, channel;
    const close = () => { channel?.destroy(); connection?.close(); socket.destroy(); };
    socket.on('error', close);
    socket.on('close', () => { sockets.delete(socket); channel?.destroy(); connection?.close(); });
    try {
      connection = await openVerifiedSsh(options);
      connections.add(connection);
      connection.closed.then(() => { connections.delete(connection); socket.destroy(); });
      if (socket.destroyed || stopping) return close();
      connection.client.forwardOut('127.0.0.1', 0, '127.0.0.1', options.remoteSshPort ?? 2222, (error, stream) => {
        if (error) return close();
        channel = stream;
        if (socket.destroyed || stopping) return close();
        stream.on('error', close);
        stream.on('close', () => socket.destroy());
        socket.pipe(stream).pipe(socket);
      });
    } catch (error) {
      options.onError?.(error.message);
      close();
    }
  });
  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const socket of sockets) socket.destroy();
    for (const connection of connections) connection.close();
    server.close();
  };
  const onSignal = () => stop();
  server.once('close', () => {
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    resolveClosed();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 22222, '127.0.0.1', resolve);
    });
  } catch (error) { stop(); throw error; }
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  return { host: '127.0.0.1', port: server.address().port, pid: process.pid, stop, closed };
}
