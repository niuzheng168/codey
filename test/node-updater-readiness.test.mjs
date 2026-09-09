import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForCloudCliReady } from '../node-updater/probe.mjs';

function clock() {
  let elapsed = 0;
  return { now: () => elapsed, sleep: async (ms) => { elapsed += ms; }, elapsed: () => elapsed };
}

test('an already-ready endpoint is requested exactly once', async () => {
  let calls = 0;
  const result = await waitForCloudCliReady(async () => { calls++; return { data: { sessions: [] } }; });
  assert.equal(calls, 1);
  assert.deepEqual(result.data.sessions, []);
});

test('a service that has not bound its port is given bounded readiness time', async () => {
  const time = clock();
  let calls = 0;
  const result = await waitForCloudCliReady(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('Starting'), { code: 'ECONNREFUSED' });
    return 'ready';
  }, { ...time, timeoutMs: 2000, intervalMs: 500 });
  assert.equal(result, 'ready');
  assert.equal(calls, 3);
  assert.equal(time.elapsed(), 1000);
});

test('persistent refusal still fails at the deadline', async () => {
  const time = clock();
  let calls = 0;
  await assert.rejects(waitForCloudCliReady(async () => {
    calls++;
    throw Object.assign(new Error('Not listening'), { code: 'ECONNREFUSED' });
  }, { ...time, timeoutMs: 1000, intervalMs: 500 }), /Not listening/);
  assert.equal(calls, 3);
  assert.equal(time.elapsed(), 1000);
});

test('authentication, TLS and unexpected failures are never retried', async () => {
  for (const code of ['HTTP_401', 'HTTP_403', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', undefined]) {
    let calls = 0;
    await assert.rejects(waitForCloudCliReady(async () => {
      calls++;
      throw Object.assign(new Error('Fatal probe error'), { code });
    }, clock()), /Fatal probe error/);
    assert.equal(calls, 1);
  }
});

test('a reset during startup retries only the supplied read-only request', async () => {
  let calls = 0;
  await waitForCloudCliReady(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('Starting TLS listener'), { code: 'ECONNRESET' });
    return 'ready';
  }, clock());
  assert.equal(calls, 2);
});
