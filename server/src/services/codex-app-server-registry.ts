import net from "node:net";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";

import type { CodexRolloutSyncService } from "./codex-rollout-sync";

export interface CodexAppServerInstance {
  id: string;
  endpoint: string;
  wsEndpoint: string;
  socketPath: string;
  pid: number | null;
  cwd: string | null;
  startedAt: string | null;
  source: string | null;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface RegistryThread {
  id?: unknown;
  path?: unknown;
}

function defaultRegistryDirectory(): string {
  return process.env.CODEX_APP_SERVER_REGISTRY_DIR?.trim() ||
    path.join(process.env.XDG_RUNTIME_DIR?.trim() || "/tmp", "codex-app-servers");
}

function connectWebSocket(endpoint: string): WebSocket {
  if (endpoint.startsWith("ws+unix://")) {
    const value = endpoint.slice("ws+unix://".length);
    const separator = value.lastIndexOf(":/");
    const socketPath = separator >= 0 ? value.slice(0, separator) : value;
    return new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => net.createConnection({ path: socketPath }),
    });
  }

  return new WebSocket(endpoint, { perMessageDeflate: false });
}

function parseInstance(raw: unknown): CodexAppServerInstance | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const socketPath = typeof value.socketPath === "string" ? value.socketPath.trim() : "";
  if (!id || !endpoint || !socketPath || !existsSync(socketPath)) {
    return null;
  }

  const wsEndpoint = typeof value.wsEndpoint === "string" && value.wsEndpoint.trim()
    ? value.wsEndpoint.trim()
    : `ws+unix://${socketPath}:/`;
  return {
    id,
    endpoint,
    wsEndpoint,
    socketPath,
    pid: typeof value.pid === "number" ? value.pid : null,
    cwd: typeof value.cwd === "string" ? value.cwd : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
    source: typeof value.source === "string" ? value.source : null,
  };
}

export class CodexAppServerRegistryService {
  private readonly registryDirectory: string;

  constructor(private readonly rolloutSync: CodexRolloutSyncService) {
    this.registryDirectory = defaultRegistryDirectory();
  }

  list(): CodexAppServerInstance[] {
    if (!existsSync(this.registryDirectory)) {
      return [];
    }

    return readdirSync(this.registryDirectory)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          const parsed = parseInstance(JSON.parse(readFileSync(path.join(this.registryDirectory, name), "utf8")));
          return parsed ? [parsed] : [];
        } catch {
          return [];
        }
      });
  }

  async sync(): Promise<CodexAppServerInstance[]> {
    const instances = this.list();
    await Promise.all(instances.map((instance) => this.syncInstance(instance)));
    return instances;
  }

  private async syncInstance(instance: CodexAppServerInstance): Promise<void> {
    try {
      const threads = await this.listThreads(instance);
      for (const thread of threads) {
        const rolloutPath = typeof thread.path === "string" ? thread.path.trim() : "";
        if (!rolloutPath || !existsSync(rolloutPath)) {
          continue;
        }

        const imported = this.rolloutSync.importRollout(rolloutPath);
        this.rolloutSync.attachAppServer(imported.sessionId, {
          id: instance.id,
          endpoint: instance.endpoint,
          pid: instance.pid,
        });
      }
    } catch {
      // A server can disappear while RemCodex is discovering it. The next
      // refresh will retry without making the session list endpoint fail.
    }
  }

  private listThreads(instance: CodexAppServerInstance): Promise<RegistryThread[]> {
    return new Promise((resolve, reject) => {
      const socket = connectWebSocket(instance.wsEndpoint);
      let requestId = 1;
      const pending = new Map<number, (value: unknown) => void>();
      const fail = (error: Error) => {
        socket.close();
        reject(error);
      };
      const request = (method: string, params?: unknown): Promise<unknown> => {
        const id = requestId++;
        return new Promise((requestResolve) => {
          pending.set(id, requestResolve);
          socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params } satisfies JsonRpcMessage));
        });
      };

      socket.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
      socket.once("open", async () => {
        try {
          await request("initialize", {
            clientInfo: { name: "remcodex-discovery", version: "0.1.0" },
            capabilities: { experimentalApi: true },
          });
          socket.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
          const result = await request("thread/list", { cwd: instance.cwd, limit: 100 });
          socket.close();
          const value = result && typeof result === "object" ? result as Record<string, unknown> : {};
          const threads = Array.isArray(value.data) ? value.data : Array.isArray(value.threads) ? value.threads : [];
          resolve(threads.filter((thread): thread is RegistryThread => Boolean(thread && typeof thread === "object")));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (typeof message.id !== "number") {
            return;
          }
          const resolver = pending.get(message.id);
          if (!resolver) {
            return;
          }
          pending.delete(message.id);
          if (message.error) {
            fail(new Error(`Codex app-server request failed: ${JSON.stringify(message.error)}`));
            return;
          }
          resolver(message.result);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
}
