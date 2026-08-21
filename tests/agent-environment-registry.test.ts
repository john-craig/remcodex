import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadAgentEnvironmentRegistry,
  resolveAgentEnvironment,
} from "../server/src/utils/agent-environment-registry";

function writeRegistry(value: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remcodex-agent-registry-"));
  const registryPath = path.join(root, "agent-environments.json");
  fs.writeFileSync(registryPath, JSON.stringify(value), "utf8");
  return registryPath;
}

function validRegistry(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    default: "writer",
    managed_paths: ["/var/lib/codex/environments"],
    allowed_roots: ["/var/lib/codex/environments"],
    environments: {
      writer: {
        codex_home: "/var/lib/codex/environments/writer",
        managed_path: "/var/lib/codex/environments",
      },
    },
    ...overrides,
  };
}

test("loads the versioned registry and resolves its default named environment", () => {
  const registry = loadAgentEnvironmentRegistry(writeRegistry(validRegistry()));

  assert.equal(registry.defaultEnvironment, "writer");
  assert.deepEqual(resolveAgentEnvironment(registry), {
    name: "writer",
    codexHome: "/var/lib/codex/environments/writer",
    managedPath: "/var/lib/codex/environments",
    allowedRoots: ["/var/lib/codex/environments"],
  });
});

test("keeps legacy behavior when the registry is absent", () => {
  const registry = loadAgentEnvironmentRegistry(path.join(os.tmpdir(), "missing-remcodex-agent-registry.json"));

  assert.equal(resolveAgentEnvironment(registry), null);
  assert.deepEqual(registry.environments, {});
});

test("rejects malformed versions, unknown defaults, traversal, and caller paths", () => {
  assert.throws(
    () => loadAgentEnvironmentRegistry(writeRegistry(validRegistry({ version: 2 }))),
    /version must be 1/,
  );
  assert.throws(
    () => loadAgentEnvironmentRegistry(writeRegistry(validRegistry({ default: "missing" }))),
    /is not registered/,
  );
  assert.throws(
    () =>
      loadAgentEnvironmentRegistry(
        writeRegistry(
          validRegistry({
            environments: {
              writer: {
                codex_home: "/var/lib/codex/environments/../outside",
                managed_path: "/var/lib/codex/environments",
              },
            },
          }),
        ),
      ),
    /without traversal/,
  );

  const registry = loadAgentEnvironmentRegistry(writeRegistry(validRegistry()));
  assert.throws(() => resolveAgentEnvironment(registry, "/tmp/codex-home"), /registered name/);
  assert.throws(() => resolveAgentEnvironment(registry, "unknown"), /is not registered/);
});
