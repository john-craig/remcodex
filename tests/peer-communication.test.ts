import assert from "node:assert/strict";
import test from "node:test";

import { createDatabase } from "../server/src/db/client";
import { runMigrations } from "../server/src/db/migrations";
import { PEER_LIMITS, PEER_SCOPES, PeerCommunicationService } from "../server/src/services/peer-communication";

function setup(): PeerCommunicationService {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return new PeerCommunicationService(db);
}

test("peer authorization is deny-by-default and grants are directed to a work package", () => {
  const peer = setup();
  assert.throws(
    () => peer.issueCredential({ workerId: "mixed", sessionId: "mixed-session", scopes: [PEER_SCOPES.adminGrant, PEER_SCOPES.workerMailbox] }),
    /separate credentials/,
  );
  const admin = peer.authenticate(peer.issueCredential({ workerId: "admin", sessionId: "admin-session", scopes: [PEER_SCOPES.adminGrant, PEER_SCOPES.adminRevoke] }).token);
  const worker = peer.issueCredential({ workerId: "worker-a", sessionId: "worker-session", scopes: [PEER_SCOPES.workerMailbox, PEER_SCOPES.workerSummary, PEER_SCOPES.workerTimeline] });
  const target = peer.issueCredential({ workerId: "worker-b", sessionId: "target-session", scopes: [PEER_SCOPES.workerMailbox, PEER_SCOPES.workerSummary, PEER_SCOPES.workerTimeline] });
  const grant = peer.grant(admin, { sourceWorkerId: "worker-a", targetWorkerId: "worker-b", workPackageId: "wp-1", scope: PEER_SCOPES.workerMailbox });
  assert.throws(() => peer.appendMessage(target.token, { recipientWorkerId: "worker-a", workPackageId: "wp-1", messageType: "note", timestamp: new Date().toISOString(), idempotencyKey: "target-0001", payload: {} }), /not authorized/);
  assert.throws(() => peer.appendMessage(worker.token, { recipientWorkerId: "worker-b", workPackageId: "wp-2", messageType: "note", timestamp: new Date().toISOString(), idempotencyKey: "wrong-work", payload: {} }), /not authorized/);
  assert.equal(grant.grantId.startsWith("grant_"), true);
});

test("peer envelopes use server identity, bounded payloads, idempotency, cursors, and timelines", () => {
  const peer = setup();
  const admin = peer.authenticate(peer.issueCredential({ workerId: "admin", sessionId: "admin-session", scopes: [PEER_SCOPES.adminGrant] }).token);
  const source = peer.issueCredential({ workerId: "source", sessionId: "source-session", scopes: [PEER_SCOPES.workerMailbox, PEER_SCOPES.workerTimeline, PEER_SCOPES.workerSummary] });
  const target = peer.issueCredential({ workerId: "target", sessionId: "target-session", scopes: [PEER_SCOPES.workerMailbox, PEER_SCOPES.workerTimeline, PEER_SCOPES.workerSummary] });
  const grant = peer.grant(admin, { sourceWorkerId: "source", targetWorkerId: "target", workPackageId: "wp-1", scope: PEER_SCOPES.workerMailbox });
  const timelineGrant = peer.grant(admin, { sourceWorkerId: "source", targetWorkerId: "target", workPackageId: "wp-1", scope: PEER_SCOPES.workerTimeline });
  const message = { recipientWorkerId: "target", workPackageId: "wp-1", messageType: "milestone", timestamp: new Date().toISOString(), idempotencyKey: "message-0001", payload: { value: "safe" } };
  const first = peer.appendMessage(source.token, message);
  const duplicate = peer.appendMessage(source.token, message);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.senderWorkerId, "source");
  const mailbox = peer.readMailbox(target.token, grant.grantId, PEER_LIMITS.maxMessagesPerRead + 50);
  assert.equal(mailbox.messages.length, 1);
  assert.equal(mailbox.nextCursor, first.id);
  assert.equal(peer.readMailbox(target.token, grant.grantId).messages.length, 0);
  assert.deepEqual(peer.readTimeline(source.token, timelineGrant.grantId, 100), []);
  assert.throws(() => peer.appendMessage(source.token, { ...message, idempotencyKey: "message-0002", payload: "x".repeat(PEER_LIMITS.maxPayloadBytes) }), /bound/);
});

test("peer summaries and lifecycle dormancy are audited", () => {
  const peer = setup();
  const admin = peer.authenticate(peer.issueCredential({ workerId: "admin", sessionId: "admin-session", scopes: [PEER_SCOPES.adminGrant] }).token);
  const source = peer.issueCredential({ workerId: "source", sessionId: "source-session", scopes: [PEER_SCOPES.workerSummary, PEER_SCOPES.workerTimeline] });
  const target = peer.issueCredential({ workerId: "target", sessionId: "target-session", scopes: [PEER_SCOPES.workerSummary, PEER_SCOPES.workerTimeline] });
  const grant = peer.grant(admin, { sourceWorkerId: "source", targetWorkerId: "target", workPackageId: "wp-1", scope: PEER_SCOPES.workerSummary });
  peer.publishSummary(source.token, grant.grantId, { milestone: "done", blockers: [] });
  assert.deepEqual(peer.readSummary(target.token, grant.grantId), { milestone: "done", blockers: [] });
  peer.dormantSession("source-session", "completed");
  assert.throws(() => peer.publishSummary(source.token, grant.grantId, {}), /inactive or expired/);
});
