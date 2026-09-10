import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { probeCodeyModel } from './codey-model-probe.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const { WebSocket } = createRequire(path.join(input.dependencyRoot, 'package.json'))('ws');
const base = new URL(input.base);
assert.equal(base.protocol, 'https:');

async function request(node, pathname, method = 'GET', body, { signal } = {}) {
  const timeout = AbortSignal.timeout(15000);
  const response = await fetch(`${base.origin}/cloudcli/${node}/api${pathname}`, {
    method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { Origin: base.origin, Cookie: input.cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `Codey API returned ${response.status}`);
  return response.json();
}

function openSocket(node) {
  return new WebSocket(`wss://${base.host}/cloudcli/${node}/ws`, {
    headers: { Origin: base.origin, Cookie: input.cookie }, handshakeTimeout: 10000,
  });
}

async function probe(node) {
  assert.ok(['zhn-a100', 'jpe2', 'jpe3', 'westus2'].includes(node));
  return probeCodeyModel({
    node, projectPath: input.projectPath, steering: input.steering === true, request, openSocket,
  });
}

// Wait for every probe's cleanup even when another node fails.
const results = await Promise.allSettled(input.nodes.map(probe));
const failures = results.filter((row) => row.status === 'rejected');
console.log(JSON.stringify({
  passed: failures.length === 0,
  nodes: results.filter((row) => row.status === 'fulfilled').map((row) => row.value),
  failures: failures.map((row) => row.reason instanceof AggregateError
    ? row.reason.errors.map(String).join('; ') : String(row.reason)),
}));
process.exitCode = failures.length ? 1 : 0;
