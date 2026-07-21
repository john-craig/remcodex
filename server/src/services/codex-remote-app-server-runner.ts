import net from "node:net";
import WebSocket from "ws";

import type { CodexExecLaunchInput } from "../types/codex-launch";
import type { CodexRunner } from "./codex-runner";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface McpServerStatusList {
  data?: Array<{ name?: unknown }>;
  nextCursor?: unknown;
}

export const REMOTE_APPROVAL_POLICY = "never";
export const REMOTE_SANDBOX_MODE = "danger-full-access";

export function applyMcpAutoApprovalOverrides(
  config: Record<string, unknown>,
  serverNames: string[],
): void {
  for (const rawName of serverNames) {
    const name = rawName.trim();
    if (name) {
      config[`mcp_servers.${name}.default_tools_approval_mode`] = "approve";
    }
  }
}

function connectWebSocket(endpoint: string): WebSocket {
  if (endpoint.startsWith("ws+unix://") || endpoint.startsWith("unix://")) {
    const prefix = endpoint.startsWith("ws+unix://") ? "ws+unix://" : "unix://";
    const value = endpoint.slice(prefix.length);
    const separator = value.lastIndexOf(":/");
    const socketPath = separator >= 0 ? value.slice(0, separator) : value;
    return new WebSocket("ws://localhost/", {
      perMessageDeflate: false,
      createConnection: () => net.createConnection({ path: socketPath }),
    });
  }

  return new WebSocket(endpoint, { perMessageDeflate: false });
}

export class CodexRemoteAppServerRunner implements CodexRunner {
  private socket: WebSocket | null = null;
  private readonly jsonListeners = new Set<(event: unknown) => void>();
  private readonly textListeners = new Set<(stream: "stdout" | "stderr", text: string) => void>();
  private readonly exitListeners = new Set<(exitCode: number | null) => void>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private requestId = 1;
  private finalized = false;
  private currentTurnId: string | null = null;
  private currentThreadId: string | null = null;

  constructor(
    private readonly endpoint: string,
    private readonly cwd: string,
  ) {}

  start(prompt: string, threadId?: string | null, launch?: CodexExecLaunchInput): number {
    if (!threadId) {
      throw new Error("A remote app-server session must have a Codex thread id.");
    }

    const socket = connectWebSocket(this.endpoint);
    this.socket = socket;
    this.currentThreadId = threadId;
    socket.on("open", () => {
      void this.bootstrap(prompt, threadId, launch).catch((error) => {
        this.emitText("stderr", `Failed to initialize remote Codex app-server: ${this.messageOf(error)}`);
        this.finish(1);
      });
    });
    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("error", (error) => this.emitText("stderr", this.messageOf(error)));
    socket.on("close", () => {
      this.rejectPendingRequests(new Error("Remote Codex app-server closed."));
      this.socket = null;
      if (!this.finalized) {
        this.finalized = true;
        this.exitListeners.forEach((listener) => listener(0));
      }
    });

    return 0;
  }

  stop(): void {
    if (!this.socket) {
      return;
    }
    if (this.currentTurnId) {
      void this.request("turn/interrupt", {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
      }).catch(() => undefined);
    }
    this.socket.close();
  }

  respond(requestId: number, result: unknown): boolean {
    if (!this.socket || !Number.isFinite(requestId)) {
      return false;
    }
    this.write({ jsonrpc: "2.0", id: requestId, result });
    return true;
  }

  onJsonEvent(listener: (event: unknown) => void): () => void {
    this.jsonListeners.add(listener);
    return () => this.jsonListeners.delete(listener);
  }

  onText(listener: (stream: "stdout" | "stderr", text: string) => void): () => void {
    this.textListeners.add(listener);
    return () => this.textListeners.delete(listener);
  }

  onExit(listener: (exitCode: number | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  isAlive(): boolean {
    return this.socket !== null && this.socket.readyState !== WebSocket.CLOSED;
  }

  private async bootstrap(prompt: string, threadId: string, launch?: CodexExecLaunchInput): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "remcodex", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");

    // Panoply's interactive app-server wrapper is intentionally launched with
    // Codex's dangerous bypass flag. Preserve that unattended behavior when
    // RemCodex resumes the same thread through a second client connection.
    const approvalPolicy = REMOTE_APPROVAL_POLICY;
    const sandboxMode = REMOTE_SANDBOX_MODE;
    const config = await this.buildConfig(launch);
    const result = await this.request("thread/resume", {
      threadId,
      cwd: this.cwd,
      approvalPolicy,
      sandbox: sandboxMode,
      config,
      persistExtendedHistory: true,
    }) as { thread?: { id?: string } };
    const resolvedThreadId = result.thread?.id ?? threadId;
    await this.request("turn/start", {
      threadId: resolvedThreadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      approvalPolicy,
      sandboxPolicy: this.buildSandboxPolicy(sandboxMode, launch),
      model: launch?.model ?? null,
      effort: launch?.reasoningEffort ?? null,
    });
  }

  private async buildConfig(launch: CodexExecLaunchInput | undefined): Promise<Record<string, unknown> | null> {
    const config: Record<string, unknown> = {};
    for (const name of launch?.enableFeatures ?? []) config[`features.${name}`] = true;
    for (const name of launch?.disableFeatures ?? []) config[`features.${name}`] = false;
    if (launch?.profile) config.profile = launch.profile;

    let cursor: string | null = null;
    do {
      const result = await this.request("mcpServerStatus/list", {
        cursor,
        limit: 100,
        detail: "toolsAndAuthOnly",
      }) as McpServerStatusList;
      applyMcpAutoApprovalOverrides(
        config,
        (result.data ?? []).flatMap((server) => typeof server.name === "string" ? [server.name] : []),
      );
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
    } while (cursor);

    return Object.keys(config).length ? config : null;
  }

  private buildSandboxPolicy(mode: CodexExecLaunchInput["sandbox"] | undefined, launch?: CodexExecLaunchInput): unknown {
    if (mode === "read-only") return { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false };
    if (mode === "danger-full-access") return { type: "dangerFullAccess" };
    return {
      type: "workspaceWrite",
      writableRoots: [this.cwd, ...(launch?.additionalWritableRoots ?? [])],
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const id = this.requestId++;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: object): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Remote Codex app-server is not connected.");
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.emitText("stdout", text);
      return;
    }

    if (typeof message.id === "number" && !message.method) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      this.pendingRequests.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;
    this.jsonListeners.forEach((listener) => listener(message));
    if (typeof message.id === "number") {
      this.respondUnsupportedRequest(message.id, message.method);
      return;
    }
    if (message.method === "turn/started") {
      const params = message.params as Record<string, unknown> | undefined;
      const turn = params?.turn as Record<string, unknown> | undefined;
      this.currentTurnId = typeof turn?.id === "string" ? turn.id : null;
    }
    if (message.method === "turn/completed") {
      const params = message.params as Record<string, unknown> | undefined;
      const turn = params?.turn as Record<string, unknown> | undefined;
      this.finish(turn?.status === "failed" ? 1 : 0);
    }
  }

  private respondUnsupportedRequest(id: number, method: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported server request: ${method}` } });
  }

  private finish(exitCode: number): void {
    if (this.finalized) return;
    this.finalized = true;
    this.exitListeners.forEach((listener) => listener(exitCode));
    this.socket?.close();
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
  }

  private emitText(stream: "stdout" | "stderr", text: string): void {
    if (text.trim()) this.textListeners.forEach((listener) => listener(stream, text.trimEnd()));
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
