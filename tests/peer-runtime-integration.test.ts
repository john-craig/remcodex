import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startRemCodexServer } from "../server/src/app";

async function json(response: Response): Promise<any> {
  return response.json();
}

function writeRegistry(root: string): string {
  const registryPath = path.join(root, "agent-environments.json");
  fs.writeFileSync(registryPath, JSON.stringify({ version: 1, default: "runtime", managed_paths: [root], allowed_roots: [root], environments: { runtime: { codex_home: path.join(root, "codex"), managed_path: root } } }), "utf8");
  return registryPath;
}

test("REST and MCP expose scoped peer operations without widening worker authority", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-peer-runtime-"));
  const previousAdminToken = process.env.REMCODEX_PEER_ADMIN_TOKEN;
  const previousMcpToken = process.env.REMCODEX_MCP_API_TOKEN;
  const previousRegistryPath = process.env.CODEX_AGENT_ENVIRONMENTS_PATH;
  process.env.REMCODEX_PEER_ADMIN_TOKEN = "peer-admin-test-token";
  process.env.REMCODEX_MCP_API_TOKEN = "mcp-runtime-token";
  process.env.CODEX_AGENT_ENVIRONMENTS_PATH = writeRegistry(root);
  const server = await startRemCodexServer({
    port: 0,
    databasePath: path.join(root, "remcodex.sqlite"),
    configPath: path.join(root, "missing.toml"),
    projectRootsEnv: root,
    codexCommand: "codex",
    logStartup: false,
  });

  try {
    const address = server.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const adminHeaders = { authorization: "Bearer peer-admin-test-token", "content-type": "application/json" };
    const source = await json(await fetch(`${baseUrl}/api/peer/credentials`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ workerId: "source", sessionId: "source-session", scopes: ["worker.peer.mailbox"] }),
    }));
    const target = await json(await fetch(`${baseUrl}/api/peer/credentials`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ workerId: "target", sessionId: "target-session", scopes: ["worker.peer.mailbox"] }),
    }));
    const grant = await json(await fetch(`${baseUrl}/api/peer/grants`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ sourceWorkerId: "source", targetWorkerId: "target", workPackageId: "wp-1", scope: "worker.peer.mailbox" }),
    }));
    const message = await json(await fetch(`${baseUrl}/api/peer/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${source.token}`, "content-type": "application/json" },
      body: JSON.stringify({ recipientWorkerId: "target", workPackageId: "wp-1", messageType: "note", timestamp: new Date().toISOString(), idempotencyKey: "runtime-0001", payload: { ok: true } }),
    }));
    assert.equal(message.senderWorkerId, "source");
    const mcpHeaders = { accept: "application/json, text/event-stream", authorization: "Bearer mcp-runtime-token", "content-type": "application/json" };
    const initialize = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    const mcpSessionId = initialize.headers.get("mcp-session-id");
    assert.ok(mcpSessionId);
    const call = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { ...mcpHeaders, "mcp-session-id": mcpSessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "peer-read-mailbox", arguments: { peerToken: target.token, grantId: grant.grantId } } }),
    });
    const line = (await call.text()).split("\n").find((item) => item.startsWith("data: "));
    assert.ok(line);
    const payload = JSON.parse(JSON.parse(line.slice("data: ".length)).result.content[0].text);
    assert.equal(payload.messages[0].id, message.id);
    const mailbox = await json(await fetch(`${baseUrl}/api/peer/mailbox/${grant.grantId}`, { headers: { authorization: `Bearer ${target.token}` } }));
    assert.equal(mailbox.messages.length, 0);
  } finally {
    await server.stop();
    if (previousAdminToken === undefined) delete process.env.REMCODEX_PEER_ADMIN_TOKEN;
    else process.env.REMCODEX_PEER_ADMIN_TOKEN = previousAdminToken;
    if (previousMcpToken === undefined) delete process.env.REMCODEX_MCP_API_TOKEN;
    else process.env.REMCODEX_MCP_API_TOKEN = previousMcpToken;
    if (previousRegistryPath === undefined) delete process.env.CODEX_AGENT_ENVIRONMENTS_PATH;
    else process.env.CODEX_AGENT_ENVIRONMENTS_PATH = previousRegistryPath;
  }
});
