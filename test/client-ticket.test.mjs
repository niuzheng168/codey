import test from "node:test";
import assert from "node:assert/strict";
import {
  issueClientTicket,
  verifyClientTicket,
} from "../src/client-ticket.mjs";

const signingKey = "k".repeat(48);

test("client relay tickets are scoped, expiring, and node-specific", () => {
  const issued = issueClientTicket({
    signingKey,
    nodeId: "jpe2",
    principalId: "user@example.com",
    ttlSeconds: 300,
    now: 1_000_000,
  });
  const verified = verifyClientTicket({
    signingKey,
    token: issued.token,
    nodeId: "jpe2",
    requiredScope: "usage",
    now: 1_100_000,
  });
  assert.equal(verified.nodeId, "jpe2");
  assert.equal(verified.principalId, "user@example.com");
  assert.deepEqual(verified.scopes, ["history", "usage"]);
  assert.throws(
    () =>
      verifyClientTicket({
        signingKey,
        token: issued.token,
        nodeId: "jpe3",
        requiredScope: "usage",
        now: 1_100_000,
      }),
    /expired or invalid/,
  );
  assert.throws(
    () =>
      verifyClientTicket({
        signingKey,
        token: issued.token,
        nodeId: "jpe2",
        requiredScope: "usage",
        now: 1_400_000,
      }),
    /expired or invalid/,
  );
});

test("client relay tickets reject tampering and missing scopes", () => {
  const issued = issueClientTicket({
    signingKey,
    nodeId: "local",
    principalId: "principal",
    scopes: ["history"],
  });
  assert.throws(
    () =>
      verifyClientTicket({
        signingKey,
        token: `${issued.token.slice(0, -1)}x`,
        nodeId: "local",
        requiredScope: "history",
      }),
    /signature/,
  );
  assert.throws(
    () =>
      verifyClientTicket({
        signingKey,
        token: issued.token,
        nodeId: "local",
        requiredScope: "usage",
      }),
    /scope/,
  );
});
