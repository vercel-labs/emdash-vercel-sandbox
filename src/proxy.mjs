import { openVerifiedSsh } from './ssh-command.mjs';

export async function runStdioProxy(options, { input = process.stdin, output = process.stdout, connect = openVerifiedSsh } = {}) {
  const abort = new AbortController();
  const buffered = [];
  let bytes = 0, connection, stream, finished = false, rejectDone, resolveDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const finish = error => {
    if (finished) return;
    finished = true; abort.abort();
    input.unpipe(stream); stream?.unpipe(output);
    stream?.destroy(); connection?.close(); input.pause();
    if (error) rejectDone(error); else resolveDone();
  };
  const failed = () => finish(new Error('Vercel connection closed. Check host status, then reconnect in EmDash.'));
  const ended = () => finish();
  const collect = chunk => {
    bytes += chunk.length;
    if (bytes > 512 * 1024) return finish(new Error('SSH handshake input exceeded its limit'));
    buffered.push(Buffer.from(chunk));
  };
  input.on('error', failed); output.on('error', failed);
  input.once('end', ended); input.once('close', ended);
  process.once('SIGTERM', ended); process.once('SIGINT', ended);
  // Drain into a bounded local buffer so EOF is observable before authentication completes.
  input.on('data', collect);
  const pending = (async () => {
    try {
      connection = await connect({ ...options, signal: abort.signal });
      if (finished || input.destroyed || input.readableEnded) { connection.close(); finish(); return; }
      let rejectForward;
      connection.closed.then(() => { rejectForward?.(new Error('Connection closed')); ended(); });
      stream = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Forwarding timed out')), 20000);
        rejectForward = error => { clearTimeout(timer); reject(error); };
        connection.client.forwardOut('127.0.0.1', 0, '127.0.0.1', options.remoteSshPort ?? 2222, (error, channel) => {
          clearTimeout(timer); rejectForward = null;
          if (finished) { channel?.destroy(); reject(new Error('Connection closed')); }
          else if (error) reject(error); else resolve(channel);
        });
      });
      if (finished) { stream.destroy(); connection.close(); return; }
      input.pause(); input.removeListener('data', collect);
      stream.on('error', failed); stream.once('close', ended);
      stream.pipe(output, { end: false });
      for (const chunk of buffered) stream.write(chunk);
      buffered.length = 0;
      input.pipe(stream);
    } catch (error) {
      finish(new Error(error.message === 'SSH host identity mismatch' ? 'SSH host identity mismatch; connection refused.' : 'Could not connect to the Vercel host. Check status or start it, then reconnect.'));
    }
  })();
  try { await done; } finally {
    input.removeListener('data', collect);
    input.removeListener('error', failed); output.removeListener('error', failed);
    input.removeListener('end', ended); input.removeListener('close', ended);
    process.removeListener('SIGTERM', ended); process.removeListener('SIGINT', ended);
    await pending;
  }
}
