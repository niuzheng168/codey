import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import tls from 'node:tls';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/** Wait only for the idempotent authenticated readiness GET, never a model send or session creation. */
export async function waitForCloudCliReady(request, {
  timeoutMs = 30000, intervalMs = 500, now = () => performance.now(), sleep = delay,
} = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    try {
      return await request();
    } catch (error) {
      // TLS, ownership, authentication and application errors remain fatal.
      // systemctl's "active" state can precede a simple service binding its port.
      if (!['ECONNREFUSED', 'ECONNRESET'].includes(error?.code) || now() >= deadline) throw error;
      await sleep(Math.min(intervalMs, deadline - now()));
    }
  }
}

async function main() {
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
assert.ok(['idle', 'verify'].includes(input.mode));
assert.ok(Number.isSafeInteger(input.cloudcliPid) && input.cloudcliPid > 0);
const environ = Object.fromEntries((await readFile(`/proc/${input.cloudcliPid}/environ`)).toString()
  .split('\0').filter((part) => part.includes('=')).map((part) => {
    const index = part.indexOf('='); return [part.slice(0, index), part.slice(index + 1)];
  }));
assert.equal(environ.CODEY_PORTAL_NODE_ID, input.nodeId);
assert.equal(environ.CODEY_PORTAL_PRINCIPAL_ID, input.ownerId);
const key = Buffer.from(environ.CODEY_PORTAL_SSO_KEY, 'base64url');
assert.equal(key.length, 32);
const certificate = await readFile(environ.CODEY_PORTAL_TLS_CERT);
const leaf = new X509Certificate(certificate);
const servername = leaf.subjectAltName.split(', ').find((item) => item.startsWith('DNS:'))?.slice(4);
assert.ok(servername);
const fingerprint = leaf.fingerprint256;
const connection = {
  hostname: environ.HOST, port: Number(environ.SERVER_PORT || 3001), servername,
  ca: certificate, allowPartialTrustChain: true, rejectUnauthorized: true,
  checkServerIdentity(host, peer) {
    return tls.checkServerIdentity(host, peer) ||
      (peer.fingerprint256 === fingerprint ? undefined : new Error('Node TLS fingerprint differs'));
  },
};
// Match the backend SSO contract: a 64-hex session id and a 22-char nonce.
const sid = randomBytes(32).toString('hex');

function headers(method, pathname) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: 'codey-portal', aud: input.nodeId, sub: input.ownerId, username: input.username,
    sid, method, path: pathname, iat: now, exp: now + 20, nonce: randomBytes(16).toString('base64url'),
  })).toString('base64url');
  return {
    Origin: input.portalOrigin, 'x-codey-workspace-assertion': `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`,
    'Content-Type': 'application/json',
  };
}

function request(pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const content = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({
      ...connection, path: pathname, method,
      headers: { ...headers(method, pathname), ...(content ? { 'Content-Length': content.length } : {}) },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) req.destroy(new Error('Oversized probe response'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200 && response.statusCode !== 201) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    req.setTimeout(15000, () => req.destroy(new Error('Node HTTP probe timed out')));
    req.on('error', reject);
    req.end(content);
  });
}

const running = (await waitForCloudCliReady(() => request('/api/providers/sessions/running'))).data.sessions;
assert.ok(Array.isArray(running));
if (input.mode === 'idle') {
  console.log(JSON.stringify({ runningSessions: running.length }));
} else {
  const { WebSocket } = createRequire(path.join(input.cloudcliPath, 'package.json'))('ws');
  const marker = 'CODEY_NODE_UPDATE_OK';
  const created = (await request('/api/providers/sessions', 'POST', {
    provider: 'codex', projectPath: input.probePath, initialMessage: 'Authorized node update connectivity check',
  })).data;
  const sessionId = created.sessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  let socket;
  let completed = false;
  try {
    await new Promise((resolve, reject) => {
      let finished = false;
      const texts = new Map();
      const timer = setTimeout(() => finish(new Error('Codey inference timeout')), 60000);
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'chat.abort', sessionId }));
        socket?.close();
        error ? reject(error) : resolve();
      }
      const authority = `${environ.HOST}:${connection.port}`;
      socket = new WebSocket(`wss://${authority}/ws`, {
        ...connection, headers: headers('GET', '/ws'), handshakeTimeout: 10000,
      });
      socket.once('open', () => socket.send(JSON.stringify({
        type: 'chat.send', sessionId,
        content: `This is an authorized model connectivity check. Reply with exactly ${marker}. Do not use tools, read files, browse or make changes.`,
        options: { permissionMode: 'default', ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}) },
      })));
      socket.on('error', () => finish(new Error('Codey WebSocket failed')));
      socket.on('message', (bytes) => {
        let event;
        try { event = JSON.parse(bytes.toString()); } catch { return finish(new Error('Malformed model event')); }
        if (event.sessionId !== sessionId) return;
        if (['tool_use', 'permission_request', 'protocol_error', 'error'].includes(event.kind)) {
          return finish(new Error('Synthetic model probe must not execute tools'));
        }
        if (event.kind === 'text') texts.set(event.id ?? event.messageId ?? 'answer', event.content);
        if (event.kind === 'complete') {
          completed = true;
          if (!event.success || event.aborted || [...texts.values()].at(-1)?.trim() !== marker) {
            return finish(new Error('Unexpected model response'));
          }
          finish();
        }
      });
      socket.once('close', () => { if (!finished) finish(new Error('Model stream ended early')); });
    });
  } finally {
    if (!completed && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'chat.abort', sessionId }));
    socket?.close();
    const removed = (await request(`/api/providers/sessions/${sessionId}`, 'DELETE')).data;
    assert.equal(removed.action, 'archived');
  }
  console.log(JSON.stringify({ passed: true, codeyModel: true, syntheticSessionArchived: true }));
}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
