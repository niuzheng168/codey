import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { probeCodeyModel } from '../skills/codey-deploy/scripts/codey-model-probe.mjs';

const sessionId = '12345678-1234-1234-1234-123456789abc';
const runId = 'original-run';
const foreignDraft = { scope: 'another-user-session', text: 'Do not touch', queuedMessage: { id: 'foreign' } };

function fixture(fault) {
  const calls = [];
  const sends = [];
  let draft;
  let marker;
  let steerCalls = 0;
  let archived = false;
  let active = false;
  let observationCount = 0;
  const socket = new EventEmitter();
  socket.readyState = 0;
  const event = (value) => socket.emit('message', Buffer.from(JSON.stringify({ sessionId, runId, ...value })));
  socket.close = () => {
    socket.readyState = 3;
    socket.emit('close');
  };
  socket.send = (raw) => {
    const value = JSON.parse(raw);
    sends.push(value);
    assert.equal(value.sessionId, sessionId, 'Never send or abort another session');
    if (value.type === 'chat.abort') {
      active = false;
      return;
    }
    assert.equal(value.type, 'chat.send', 'Legacy chat.steer must never pass queue acceptance');
    active = true;
    queueMicrotask(() => {
      if (!value.content.includes('CODEY_ORIGINAL_DIRECTION')) {
        event({ kind: 'text', role: 'assistant', content: 'CODEY_FAST_DEPLOY_OK' });
        active = false;
        event({ kind: 'complete', success: true });
        return;
      }
      if (fault === 'no-steering') {
        active = false;
        event({ kind: 'complete', success: true });
      } else {
        event({ kind: 'status', canSteer: true, canSteerQueued: fault !== 'old-backend' });
        // Repeated status must not trigger another accepted correction.
        event({ kind: 'status', canSteer: true, canSteerQueued: fault !== 'old-backend' });
      }
    });
  };
  const complete = () => {
    if (fault === 'timeout') return;
    event({ kind: 'text', id: 'steer-echo', role: 'user', content: draft.queuedContent });
    if (fault === 'tool-use') {
      event({ kind: 'tool_use' });
      return;
    }
    if (fault !== 'echo-only') {
      event({
        kind: 'text', id: 'assistant-answer', role: 'assistant',
        content: fault === 'wrong-answer' ? 'CODEY_ORIGINAL_DIRECTION' : marker,
        ...(fault === 'different-run' ? { runId: 'new-run' } : {}),
      });
    }
    active = false;
    event({ kind: 'complete', success: true });
    if (fault === 'double-complete') event({ kind: 'complete', success: true });
  };
  async function request(node, pathname, method = 'GET', body) {
    assert.equal(node, 'westus2');
    calls.push({ pathname, method, body });
    if (pathname === '/providers/sessions' && method === 'POST') return { data: { sessionId } };
    if (pathname === '/providers/sessions/running') {
      return { data: { sessions: [{ sessionId: 'real-user-run' }, ...(active ? [{ sessionId }] : [])] } };
    }
    if (pathname === `/providers/sessions/${sessionId}/provider-id`) return { data: { sessionId: 'native-thread' } };
    if (pathname === `/providers/sessions/${sessionId}` && method === 'DELETE') {
      assert.equal(active, false, 'Do not archive active sessions');
      archived = true;
      return { data: { action: 'archived', sessionId } };
    }
    if (pathname === '/user/drafts') {
      if (method === 'GET') return { drafts: [foreignDraft, draft].filter(Boolean) };
      assert.equal(body.scope, sessionId, 'Only mutate the synthetic draft');
      if (method === 'PUT') {
        if (body.preserveQueuedMessage && fault !== 'resurrected-queue') {
          draft.text = body.text;
        } else {
          draft = { ...body, queuedContent: body.queuedMessage.content };
        }
      } else if (method === 'DELETE') {
        draft = undefined;
      } else {
        assert.fail(`Unexpected draft method: ${method}`);
      }
      return {};
    }
    if (pathname === '/user/drafts/steer' && method === 'POST') {
      assert.equal(body.scope, sessionId);
      assert.equal(body.expectedRunId, runId);
      const base = { kind: 'chat_steer_result', sessionId, requestId: body.requestId };
      if (++steerCalls > 1) {
        return { ...base, accepted: fault === 'duplicate-accepted', code: 'STEER_QUEUE_CHANGED' };
      }
      assert.deepEqual(body.queuedMessage, draft.queuedMessage);
      marker = body.queuedMessage.content.match(/CODEY_QUEUE_STEER_[a-f0-9]{32}/)?.[0];
      assert.ok(marker);
      assert.ok(!sends[0].content.includes(marker), 'Original prompt must not contain the eventual expected answer');
      if (fault === 'refused') return { ...base, accepted: false, code: 'STEER_UNAVAILABLE' };
      if (fault === 'lost-draft') draft.text = '';
      if (fault !== 'unconsumed') draft.queuedMessage = null;
      // Deliberately race stream completion BEFORE the HTTP ack.
      queueMicrotask(complete);
      return { ...base, accepted: true, ...(fault === 'wrong-ack' ? { requestId: 'other-request' } : {}) };
    }
    assert.fail(`Unexpected API: ${method} ${pathname}`);
  }
  return {
    calls, sends,
    get archived() { return archived; },
    get draft() { return draft; },
    get observationCount() { return observationCount; },
    run(steering = true) {
      return probeCodeyModel({
        node: 'westus2', projectPath: '/isolated/probe', request, steering,
        timeoutMs: fault === 'timeout' ? 20 : 1000,
        settleMs: 32500,
        openSocket() {
          queueMicrotask(() => {
            socket.readyState = 1;
            socket.emit('open');
          });
          return socket;
        },
        async wait(ms) {
          assert.equal(ms, 32500);
          observationCount++;
          if (fault === 'delayed-second-run') event({ kind: 'status', runId: 'duplicate-run' });
        },
      });
    },
  };
}

test('queued probe uses the real HTTP queue protocol, checks same-turn answer and cleans up', async () => {
  const state = fixture();
  const result = await state.run();
  assert.equal(result.protocol, 'http-queued-steering');
  assert.equal(result.steerAccepted, true);
  assert.equal(result.sameRun, true);
  assert.equal(result.initialSends, 1);
  assert.equal(result.corrections, 1);
  assert.equal(result.completedRuns, 1);
  assert.equal(result.acceptedEchoes, 1);
  assert.equal(result.queueConsumed, true);
  assert.equal(result.duplicateRefused, true);
  assert.equal(result.lateAutosaveSafe, true);
  assert.equal(result.independentDraftPreserved, true);
  assert.equal(result.testSessionArchived, true);
  assert.match(result.response, /^CODEY_QUEUE_STEER_[a-f0-9]{32}$/);
  assert.equal(state.sends.length, 1);
  const steering = state.calls.filter((row) => row.pathname === '/user/drafts/steer');
  assert.equal(steering.length, 2);
  assert.notEqual(steering[0].body.requestId, steering[1].body.requestId);
  assert.deepEqual(steering[0].body.queuedMessage, steering[1].body.queuedMessage);
  assert.equal(state.observationCount, 1);
  assert.equal(state.draft, undefined);
  assert.equal(state.archived, true);
});

test('generic connectivity probe remains a single no-tools turn without queue mutations', async () => {
  const state = fixture();
  const result = await state.run(false);
  assert.equal(result.response, 'CODEY_FAST_DEPLOY_OK');
  assert.equal(state.archived, true);
  assert.equal(state.sends.length, 1);
  assert.equal(state.calls.some((row) => row.pathname.startsWith('/user/')), false);
});

for (const [fault, reason] of [
  ['old-backend', /Deployed backend does not support queued steering/],
  ['no-steering', /did not advertise queued steering/],
  ['refused', /Queued steering refused/],
  ['wrong-ack', /other-request/],
  ['unconsumed', /queue receipt was not consumed/],
  ['lost-draft', /independent composer draft/],
  ['duplicate-accepted', /accepted twice/],
  ['resurrected-queue', /queue receipt was not consumed/],
  ['wrong-answer', /unpredictable instruction/],
  ['echo-only', /unpredictable instruction/],
  ['different-run', /different run/],
  ['double-complete', /ran more than once/],
  ['delayed-second-run', /different run/],
  ['tool-use', /Unexpected synthetic probe event: tool_use/],
  ['timeout', /probe timed out/],
]) {
  test(`rejects ${fault} rather than declaring queue steering healthy`, async () => {
    const state = fixture(fault);
    await assert.rejects(state.run(), reason);
    assert.equal(state.archived, true);
    assert.equal(state.draft, undefined);
    assert.ok(state.sends.every((row) => row.sessionId === sessionId));
  });
}
