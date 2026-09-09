import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const { WebSocket } = createRequire(path.join(input.dependencyRoot, 'package.json'))('ws');
const base = new URL(input.base);
assert.equal(base.protocol, 'https:');
const marker = input.steering ? 'CODEY_STEER_SAME_TURN_OK' : 'CODEY_FAST_DEPLOY_OK';

async function api(node, pathname, method = 'GET', body) {
  const response = await fetch(`${base.origin}/cloudcli/${node}/api/providers${pathname}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Origin: base.origin, Cookie: input.cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `Codey API returned ${response.status}`);
  return (await response.json()).data;
}

async function probe(node) {
  assert.ok(['zhn-a100', 'jpe2', 'jpe3', 'westus2'].includes(node));
  const started = Date.now();
  const created = await api(node, '/sessions', 'POST', {
    provider: 'codex', projectPath: input.projectPath, initialMessage: 'Codey fast release connectivity check',
  });
  const sessionId = created.sessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  let socket;
  let completed = false;
  let steerAccepted = false;
  let runId = null;
  try {
    const answer = await new Promise((resolve, reject) => {
      let settled = false;
      const texts = new Map();
      const steerRequestId = randomUUID();
      let steerSent = false;
      let completionEvent = null;
      const timer = setTimeout(() => finish(new Error('Codey model exceeded 60 seconds')), 60000);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error && !completed && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'chat.abort', sessionId }));
        }
        socket?.close();
        error ? reject(error) : resolve(value);
      }
      function finishIfReady() {
        if (!completionEvent || (input.steering && !steerAccepted)) return;
        const text = [...texts.values()].at(-1)?.trim();
        if (!completionEvent.success || completionEvent.aborted || text !== marker) {
          return finish(new Error('Codey model did not return the expected marker'));
        }
        finish(null, text);
      }
      socket = new WebSocket(`wss://${base.host}/cloudcli/${node}/ws`, {
        headers: { Origin: base.origin, Cookie: input.cookie }, handshakeTimeout: 10000,
      });
      socket.once('open', () => socket.send(JSON.stringify({
        type: 'chat.send', sessionId,
        content: `Authorized deployment check. Reply with exactly ${input.steering ? 'CODEY_ORIGINAL_DIRECTION' : marker}. Do not use tools, access files, browse, or make changes.`,
        options: { model: 'gpt-6-astra', effort: 'max', permissionMode: 'default' },
      })));
      socket.on('error', () => finish(new Error('Codey WebSocket failed')));
      socket.on('message', (body) => {
        const event = JSON.parse(body.toString());
        if (event.sessionId !== sessionId) return;
        if (['protocol_error', 'error', 'tool_use', 'permission_request'].includes(event.kind)) {
          return finish(new Error(`Unexpected synthetic probe event: ${event.kind}`));
        }
        if (input.steering && event.kind === 'status' && event.canSteer && !steerSent) {
          if (typeof event.runId !== 'string') return finish(new Error('Missing native steering admission token'));
          runId = event.runId;
          steerSent = true;
          socket.send(JSON.stringify({
            type: 'chat.steer', sessionId, requestId: steerRequestId, expectedRunId: runId,
            content: `Change direction now: ignore the previous requested response and reply with exactly ${marker}. Do not use tools, access files, browse, or make changes.`,
            options: { attachments: [] },
          }));
        }
        if (event.kind === 'chat_steer_result' && event.requestId === steerRequestId) {
          if (!event.accepted) return finish(new Error(`Native steering refused: ${event.code}`));
          steerAccepted = true;
          finishIfReady();
        }
        if (input.steering && runId && event.runId && event.runId !== runId) {
          return finish(new Error('Correction moved to a different run'));
        }
        if (event.kind === 'text' && event.role !== 'user' && typeof event.content === 'string') {
          texts.set(event.id ?? event.messageId ?? 'answer', event.content);
        }
        if (event.kind === 'complete') {
          completed = true;
          completionEvent = event;
          if (input.steering && !steerSent) return finish(new Error('The run did not advertise native steering'));
          // Completion notifications may race the correlated steer RPC ack.
          finishIfReady();
        }
      });
      socket.once('close', () => {
        if (!settled) finish(new Error('Codey stream closed before completion'));
      });
    });
    const native = await api(node, `/sessions/${sessionId}/provider-id`);
    return { node, passed: true, response: answer, model: 'gpt-6-astra', effort: 'max',
      appSessionId: sessionId, nativeSessionId: native.sessionId,
      ...(input.steering ? { steerAccepted, sameRun: true, runId, initialSends: 1, corrections: 1 } : {}),
      seconds: Math.round((Date.now() - started) / 100) / 10, testSessionArchived: true };
  } finally {
    if (!completed && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'chat.abort', sessionId }));
    }
    socket?.close();
    const removed = await api(node, `/sessions/${sessionId}`, 'DELETE');
    assert.equal(removed.action, 'archived');
    assert.equal(removed.sessionId, sessionId);
  }
}

// Wait for every probe's cleanup even when another node fails.
const results = await Promise.allSettled(input.nodes.map(probe));
const failures = results.filter((row) => row.status === 'rejected');
console.log(JSON.stringify({
  passed: failures.length === 0,
  nodes: results.filter((row) => row.status === 'fulfilled').map((row) => row.value),
  failures: failures.map((row) => String(row.reason)),
}));
process.exitCode = failures.length ? 1 : 0;
