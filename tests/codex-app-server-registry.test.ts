import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexAppServerRegistryService } from "../server/src/services/codex-app-server-registry";

test("lists app-server instances only while their socket is present", () => {
  const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-app-server-registry-"));
  const socketPath = path.join(registryDirectory, "session.sock");
  const registryPath = path.join(registryDirectory, "session.json");
  fs.writeFileSync(socketPath, "");
  fs.writeFileSync(
    registryPath,
    JSON.stringify({
      id: "tui-session",
      endpoint: "unix://session.sock",
      wsEndpoint: `ws+unix://${socketPath}:/`,
      socketPath,
      pid: process.pid,
      cwd: registryDirectory,
      startedAt: new Date().toISOString(),
      source: "test",
    }),
  );

  const previousDirectory = process.env.CODEX_APP_SERVER_REGISTRY_DIR;
  process.env.CODEX_APP_SERVER_REGISTRY_DIR = registryDirectory;
  try {
    const registry = new CodexAppServerRegistryService({} as never);
    assert.deepEqual(registry.list().map((instance) => instance.id), ["tui-session"]);

    fs.unlinkSync(socketPath);
    assert.deepEqual(registry.list(), []);
  } finally {
    if (previousDirectory === undefined) {
      delete process.env.CODEX_APP_SERVER_REGISTRY_DIR;
    } else {
      process.env.CODEX_APP_SERVER_REGISTRY_DIR = previousDirectory;
    }
    fs.rmSync(registryDirectory, { recursive: true, force: true });
  }
});
