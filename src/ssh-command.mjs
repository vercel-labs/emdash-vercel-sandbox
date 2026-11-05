import ssh2 from 'ssh2';
import WebSocket, { createWebSocketStream } from 'ws';
import { makeHostVerifier } from './keys.mjs';
const { Client } = ssh2;

export function websocketUrl(url) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) ||
      (parsed.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname))) {
    throw new Error('Bridge URL must use HTTPS (HTTP allowed only for local tests)');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid bridge URL');
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/ssh';
  return parsed;
}

export async function openVerifiedSsh(options) {
  options.signal?.throwIfAborted();
  const verify = makeHostVerifier(options.hostPublicKey);
  const websocket = new WebSocket(websocketUrl(options.bridgeUrl), {
    headers: { Authorization: 'Bearer ' + options.bridgeToken },
    perMessageDeflate: false, handshakeTimeout: 15000,
  });
  const wire = createWebSocketStream(websocket);
  const client = new Client();
  let closing = false, ready = false, mismatch = false, rejectReady;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const close = () => {
    if (closing) return;
    closing = true;
    options.signal?.removeEventListener('abort', cancelled);
    client.destroy(); wire.destroy(); websocket.terminate();
    resolveClosed();
  };
  const fail = () => {
    rejectReady?.(new Error(mismatch ? 'SSH host identity mismatch' : 'SSH transport or authentication failed'));
    close();
  };
  const cancelled = () => { rejectReady?.(new Error('SSH connection cancelled')); close(); };
  options.signal?.addEventListener('abort', cancelled, { once: true });
  websocket.on('error', fail);
  wire.on('error', fail);
  client.on('error', fail);
  client.on('close', () => { if (!ready) fail(); else close(); });
  websocket.on('close', () => { if (!ready) fail(); else close(); });
  await new Promise((resolve, reject) => {
    rejectReady = reject;
    if (options.signal?.aborted) { cancelled(); return; }
    const timeout = setTimeout(fail, 20000);
    closed.then(() => clearTimeout(timeout));
    client.once('ready', () => {
      clearTimeout(timeout); ready = true; rejectReady = null; resolve();
    });
    try {
      client.connect({
        sock: wire, username: 'emdash', privateKey: options.privateKey,
        hostVerifier: key => { const valid = verify(key); mismatch = !valid; return valid; },
        readyTimeout: 20000, keepaliveInterval: 10000, keepaliveCountMax: 3,
      });
    } catch { fail(); }
  });
  return { client, close, closed };
}

export async function openSshCommandChannel(options) {
  const connection = await openVerifiedSsh(options);
  return {
    ...connection,
    exec(command, timeoutMs = 120000) {
      return new Promise((resolve, reject) => {
        let channel, ended = false, bytes = 0;
        const stdout = [], stderr = [];
        const finish = (error, code) => {
          if (ended) return;
          ended = true; clearTimeout(timer); channel?.destroy();
          const result = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), exitCode: code };
          if (error || code !== 0) reject(Object.assign(new Error(error || 'Remote command failed'), result));
          else resolve(result);
        };
        const timer = setTimeout(() => finish('Remote command timed out'), timeoutMs);
        connection.closed.then(() => finish('SSH connection closed'));
        connection.client.exec(command, (error, stream) => {
          if (error) return finish('SSH exec request failed');
          channel = stream;
          if (ended) return stream.destroy();
          const collect = target => data => {
            bytes += data.length;
            if (bytes > 128 * 1024 * 1024) return finish('Remote output exceeded 128 MiB');
            target.push(Buffer.from(data));
          };
          stream.on('data', collect(stdout));
          stream.stderr.on('data', collect(stderr));
          stream.on('error', () => finish('SSH command stream failed'));
          stream.on('close', code => finish(null, code));
        });
      });
    },
  };
}
