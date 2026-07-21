import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMcpAutoApprovalOverrides,
  REMOTE_APPROVAL_POLICY,
  REMOTE_SANDBOX_MODE,
} from "../server/src/services/codex-remote-app-server-runner";

test("remote sessions bypass interactive approvals", () => {
  assert.equal(REMOTE_APPROVAL_POLICY, "never");
  assert.equal(REMOTE_SANDBOX_MODE, "danger-full-access");
});

test("remote sessions auto-approve every discovered MCP server", () => {
  const config: Record<string, unknown> = {
    profile: "orchestrator",
  };

  applyMcpAutoApprovalOverrides(config, ["rhizomatic_server", " vikunja ", ""]);

  assert.deepEqual(config, {
    profile: "orchestrator",
    "mcp_servers.rhizomatic_server.default_tools_approval_mode": "approve",
    "mcp_servers.vikunja.default_tools_approval_mode": "approve",
  });
});
