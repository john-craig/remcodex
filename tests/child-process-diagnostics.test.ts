import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDatabase } from "../server/src/db/client";
import { runMigrations } from "../server/src/db/migrations";
import { EventStore } from "../server/src/services/event-store";
import { ProjectManager } from "../server/src/services/project-manager";
import { SessionManager } from "../server/src/services/session-manager";

function makeProject(codexCommand: string, codexMode: "exec-json" | "app-server") {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-diagnostics-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const eventStore = new EventStore(db);
  const projectManager = new ProjectManager(db, root, process.cwd());
  const manager = new SessionManager({
    db,
    eventStore,
    projectManager,
    codexCommand,
    codexMode,
  });
  const project = projectManager.createProject({ name: "Diagnostics", path: projectPath });
  const session = manager.createSession({ projectId: project.id });
  return { eventStore, manager, projectPath, session };
}

function writeLauncher(root: string, script: string): string {
  const scriptPath = path.join(root, "runner.cjs");
  const launcherPath = path.join(root, "runner");
  fs.writeFileSync(scriptPath, script);
  fs.writeFileSync(launcherPath, `#!/bin/sh\nexec ${process.execPath} ${scriptPath} "$@"\n`);
  fs.chmodSync(launcherPath, 0o755);
  return launcherPath;
}

async function waitForFailed(manager: SessionManager, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getSession(sessionId)?.status === "failed") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("session did not reach failed state");
}

test("persists stderr, command, cwd, and exit status for failed exec processes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-exec-runner-"));
  const command = writeLauncher(root, "process.stderr.write('exec diagnostic\\n'); process.exit(7);\n");
  const { eventStore, manager, projectPath, session } = makeProject(command, "exec-json");

  manager.sendMessage(session.id, "trigger failure");
  await waitForFailed(manager, session.id);

  const error = eventStore.listAll(session.id).find((event) => event.type === "error");
  assert.ok(error);
  assert.equal(error.payload.details?.command, command);
  assert.equal(error.payload.details?.cwd, projectPath);
  assert.equal(error.payload.details?.exitCode, 7);
  assert.equal(error.payload.details?.stderr, "exec diagnostic");
  assert.equal(error.payload.details?.executionMode, "exec-json");
});

test("persists stderr from app-server bootstrap failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-app-server-"));
  const command = writeLauncher(
    root,
    `const readline = require("node:readline");
process.stderr.write("bootstrap diagnostic\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { message: "bootstrap failed" } }) + "\\n");
});
`,
  );
  const { eventStore, manager, session } = makeProject(command, "app-server");

  manager.sendMessage(session.id, "trigger bootstrap failure");
  await waitForFailed(manager, session.id);

  const error = eventStore.listAll(session.id).find((event) => event.type === "error");
  assert.ok(error);
  assert.match(String(error.payload.details?.stderr), /bootstrap diagnostic/);
  assert.equal(error.payload.details?.exitCode, 1);
  assert.equal(error.payload.details?.executionMode, "app-server");
});
