import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const options = { model: 'gpt-6-astra', effort: 'max', permissionMode: 'default' };
const noTools = 'Do not use tools, access files, browse, or make changes.';

// Transport injection keeps offline tests credential-free. Production still uses
// the authenticated Portal, actual queue API and actual Codex app-server.
export async function probeCodeyModel({
  node, projectPath, request, openSocket, steering = false,
  timeoutMs = steering ? 120000 : 60000, settleMs = 32500,
  wait = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  const started = Date.now();
  const created = await request(node, '/providers/sessions', 'POST', {
    provider: 'codex', projectPath, initialMessage: `Codey deployment check ${randomUUID()}`,
  });
  const sessionId = created.data?.sessionId;
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  let socket;
  let completed = false;
  let failure;
  let runId;
  let marker = 'CODEY_FAST_DEPLOY_OK';
  let receipt;
  let independentDraft;
  let duplicateCode;
  let accepted = false;
  let completeCount = 0;
  const runIds = new Set();
  const echoIds = new Set();
  const controller = new AbortController();
  const api = (pathname, method, body) => request(node, pathname, method, body, { signal: controller.signal });
  const ownDraft = async () => {
    const result = await api('/user/drafts');
    assert.ok(Array.isArray(result.drafts), 'Invalid drafts response');
    const draft = result.drafts.find((row) => row.scope === sessionId);
    assert.ok(draft, 'Independent composer draft disappeared');
    assert.equal(draft.text, independentDraft, 'Steering overwrote the independent composer draft');
    assert.equal(draft.queuedMessage, null, 'Accepted queue receipt was not consumed');
  };

  try {
    const answer = await new Promise((resolve, reject) => {
      let settled = false;
      let verifying = false;
      let steerStarted = false;
      let queueChecked = false;
      let completionEvent;
      const texts = new Map();
      const timer = setTimeout(() => finish(new Error('Codey model probe timed out')), timeoutMs);
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.abort();
        error ? reject(error) : resolve(value);
      }
      async function verifyCompletion() {
        const text = [...texts.values()].at(-1)?.trim();
        assert.ok(completionEvent.success && !completionEvent.aborted, 'Codey run did not complete successfully');
        assert.equal(text, marker, 'The assistant did not follow the new, unpredictable instruction');
        if (steering) {
          // A stale tab's ordinary autosave must not resurrect a consumed queue.
          await api('/user/drafts', 'PUT', {
            scope: sessionId, text: independentDraft, queuedMessage: receipt, preserveQueuedMessage: true,
          });
          // Include a full 30-second server dispatcher poll, not only the
          // frontend's 5-second draft refresh.
          await wait(settleMs, controller.signal);
          await ownDraft();
          assert.equal(completeCount, 1, 'Queued instruction ran more than once');
          assert.equal(runIds.size, 1, 'Queued instruction moved to another run');
          assert.equal(echoIds.size, 1, 'Expected exactly one accepted queued-message echo');
          const running = await api('/providers/sessions/running');
          assert.ok(Array.isArray(running.data?.sessions), 'Invalid running-session response');
          assert.ok(!running.data.sessions.some((row) => (row.sessionId ?? row.id) === sessionId),
            'The queued instruction started another run after completion');
        }
        finish(null, text);
      }
      function finishIfReady() {
        if (settled || verifying || !completionEvent || (steering && !queueChecked)) return;
        verifying = true;
        void verifyCompletion().catch(finish);
      }
      async function appendQueued() {
        // Generate only AFTER the original turn starts: an old response or user
        // echo cannot satisfy this probe.
        marker = `CODEY_QUEUE_STEER_${randomUUID().replaceAll('-', '')}`;
        independentDraft = `Unsent independent draft ${randomUUID()}`;
        receipt = {
          id: randomUUID(),
          content: `Change direction now: ignore the previous requested response and reply with exactly ${marker}. ${noTools}`,
          attachments: [], options,
        };
        await api('/user/drafts', 'PUT', { scope: sessionId, text: independentDraft, queuedMessage: receipt });
        const requestId = randomUUID();
        const result = await api('/user/drafts/steer', 'POST', {
          scope: sessionId, requestId, expectedRunId: runId, queuedMessage: receipt,
        });
        assert.equal(result.kind, 'chat_steer_result');
        assert.equal(result.sessionId, sessionId);
        assert.equal(result.requestId, requestId);
        assert.equal(result.accepted, true, `Queued steering refused: ${result.code}`);
        accepted = true;
        await ownDraft();

        // One accepted correction, then a deliberate replay of its consumed
        // receipt with a NEW request ID. It must never reach the model again.
        const duplicateId = randomUUID();
        const duplicate = await api('/user/drafts/steer', 'POST', {
          scope: sessionId, requestId: duplicateId, expectedRunId: runId, queuedMessage: receipt,
        });
        assert.equal(duplicate.kind, 'chat_steer_result');
        assert.equal(duplicate.sessionId, sessionId);
        assert.equal(duplicate.requestId, duplicateId);
        assert.equal(duplicate.accepted, false, 'Consumed queue receipt was accepted twice');
        duplicateCode = duplicate.code;
        assert.ok(['STEER_QUEUE_CHANGED', 'NO_ACTIVE_RUN', 'STEER_UNAVAILABLE'].includes(duplicateCode),
          `Unexpected duplicate rejection: ${duplicateCode}`);
        queueChecked = true;
        finishIfReady();
      }
      socket = openSocket(node);
      socket.once('open', () => socket.send(JSON.stringify({
        type: 'chat.send', sessionId, options,
        content: steering
          ? `Authorized deployment check. ${noTools} Write the integers from 1 through 120, one per line, then CODEY_ORIGINAL_DIRECTION.`
          : `Authorized deployment check. Reply with exactly ${marker}. ${noTools}`,
      })));
      socket.on('error', () => finish(new Error('Codey WebSocket failed')));
      socket.on('message', (body) => {
        try {
          const event = JSON.parse(body.toString());
          if (event.sessionId !== sessionId) return;
          if (event.kind === 'complete') completed = true;
          if (settled) return;
          if (['protocol_error', 'error', 'tool_use', 'permission_request'].includes(event.kind)) {
            throw new Error(`Unexpected synthetic probe event: ${event.kind}`);
          }
          if (event.runId) {
            runIds.add(event.runId);
            assert.equal(runIds.size, 1, 'Correction moved to a different run');
          }
          if (steering && event.kind === 'status' && event.canSteer && !steerStarted) {
            assert.equal(event.canSteerQueued, true, 'Deployed backend does not support queued steering');
            assert.equal(typeof event.runId, 'string', 'Missing native steering admission token');
            runId = event.runId;
            steerStarted = true;
            void appendQueued().catch(finish);
          }
          if (event.kind === 'text' && typeof event.content === 'string') {
            if (event.role === 'user') {
              if (receipt && event.content === receipt.content) {
                assert.equal(typeof event.id, 'string', 'Accepted queued-message echo has no ID');
                echoIds.add(event.id);
              }
            } else if (event.role === 'assistant') {
              texts.set(event.id ?? event.messageId ?? 'answer', event.content);
            }
          }
          if (event.kind === 'complete') {
            completeCount += 1;
            completionEvent = event;
            assert.ok(!steering || steerStarted, 'The run did not advertise queued steering');
            // Native completion can race the correlated HTTP acknowledgement.
            finishIfReady();
          }
        } catch (error) {
          finish(error);
        }
      });
      socket.once('close', () => {
        if (!settled) finish(new Error('Codey stream closed before verification'));
      });
    });
    const native = await request(node, `/providers/sessions/${sessionId}/provider-id`);
    assert.ok(native.data?.sessionId, 'Missing native session ID');
    return {
      node, passed: true, response: answer, model: options.model, effort: options.effort,
      appSessionId: sessionId, nativeSessionId: native.data.sessionId,
      ...(steering ? {
        protocol: 'http-queued-steering', steerAccepted: accepted, sameRun: true, runId,
        initialSends: 1, corrections: 1, duplicateRefused: true, duplicateCode,
        queueConsumed: true, lateAutosaveSafe: true, independentDraftPreserved: true,
        completedRuns: completeCount, acceptedEchoes: echoIds.size, postCompletionObservationMs: settleMs,
      } : {}),
      seconds: Math.round((Date.now() - started) / 100) / 10, testSessionArchived: true,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    controller.abort();
    if (!completed && socket?.readyState === 1) {
      socket.send(JSON.stringify({ type: 'chat.abort', sessionId }));
    }
    socket?.close();
    try {
      if (steering) await request(node, '/user/drafts', 'DELETE', { scope: sessionId });
      // Abort/archive ONLY the synthetic session; never force an active user run.
      if (!completed) {
        const deadline = Date.now() + 5000;
        while (true) {
          const running = await request(node, '/providers/sessions/running');
          assert.ok(Array.isArray(running.data?.sessions), 'Invalid cleanup running-session response');
          if (!running.data.sessions.some((row) => (row.sessionId ?? row.id) === sessionId)) break;
          assert.ok(Date.now() < deadline, 'Synthetic session is still stopping; refusing forced archive');
          await wait(250);
        }
      }
      const removed = await request(node, `/providers/sessions/${sessionId}`, 'DELETE');
      assert.equal(removed.data?.action, 'archived');
      assert.equal(removed.data.sessionId, sessionId);
    } catch (cleanupError) {
      throw failure ? new AggregateError([failure, cleanupError], 'Probe and cleanup failed') : cleanupError;
    }
  }
}
