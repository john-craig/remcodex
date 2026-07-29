import { randomUUID } from "node:crypto";
import path from "node:path";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { EventStore } from "./services/event-store";
import { ProjectManager } from "./services/project-manager";
import { AgentProfileManager } from "./services/agent-profile-manager";
import { SessionManager } from "./services/session-manager";
import { SessionTimelineService } from "./services/session-timeline-service";
import { CodexRolloutSyncService } from "./services/codex-rollout-sync";
import { normalizeCodexExecLaunchInput } from "./utils/codex-launch";
import { buildRemCodexSessionUrl } from "./utils/remcodex-url";

interface McpSessionEntry {
  transport: NodeStreamableHTTPServerTransport;
}

export interface RemCodexMcpDependencies {
  eventStore: EventStore;
  projectManager: ProjectManager;
  sessionManager: SessionManager;
  sessionTimeline: SessionTimelineService;
  codexRolloutSync: CodexRolloutSyncService;
  profileManager: AgentProfileManager;
}

export interface RemCodexMcpRequestOptions {
  apiToken: string;
}

interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  error: {
    code: number;
    message: string;
  };
  id: null;
}

const sessions = new Map<string, McpSessionEntry>();

function mcpJsonResult(data: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function mcpErrorResult(message: string, details?: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: details == null ? message : `${message}\n\n${JSON.stringify(details, null, 2)}`,
      },
    ],
  };
}

function serializeSession(
  session: ReturnType<SessionManager["getSession"]>,
  projectManager: ProjectManager,
  pendingApproval: unknown,
) {
  if (!session) {
    return null;
  }

  const project = projectManager.getProject(session.project_id);
  return {
    sessionId: session.id,
    title: session.title,
    projectId: session.project_id,
    parentSessionId: session.parent_session_id,
    projectName: project?.name ?? null,
    projectPath: project?.path ?? null,
    status: session.status,
    liveBusy: sessionManagerIsBusy(session.status, session.source_kind),
    pid: session.pid,
    codexThreadId: session.codex_thread_id,
    description: session.description,
    tags: session.tags,
    metadata: session.metadata,
    sourceKind: session.source_kind,
    sourceRolloutPath: session.source_rollout_path,
    sourceThreadId: session.source_thread_id,
    sourceRolloutHasOpenTurn: session.source_rollout_has_open_turn === 1,
    pendingApproval,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    sessionUrl: buildRemCodexSessionUrl(session.id),
  };
}

function serializeSessionListItem(
  session: ReturnType<SessionManager["listSessions"]>[number],
  projectManager: ProjectManager,
  pendingApproval: unknown,
) {
  const project = projectManager.getProject(session.project_id);
  return {
    sessionId: session.id,
    title: session.title,
    projectId: session.project_id,
    parentSessionId: session.parent_session_id,
    projectName: project?.name ?? null,
    projectPath: project?.path ?? null,
    status: session.status,
    liveBusy: sessionManagerIsBusy(session.status, session.source_kind),
    pid: session.pid,
    codexThreadId: session.codex_thread_id,
    description: session.description,
    tags: session.tags,
    metadata: session.metadata,
    sourceKind: session.source_kind,
    sourceRolloutPath: session.source_rollout_path,
    sourceThreadId: session.source_thread_id,
    sourceRolloutHasOpenTurn: session.source_rollout_has_open_turn === 1,
    pendingApproval,
    lastEventAt: session.last_event_at,
    lastAssistantContent: session.last_assistant_content,
    lastCommand: session.last_command,
    eventCount: session.event_count,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    sessionUrl: buildRemCodexSessionUrl(session.id),
  };
}

function sessionManagerIsBusy(status: string, sourceKind: string | null | undefined): boolean {
  if (sourceKind === "imported_rollout") {
    return status !== "idle" && status !== "completed";
  }

  return ["starting", "running", "stopping"].includes(status);
}

function jsonRpcError(code: number, message: string): JsonRpcErrorBody {
  return {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  };
}

function normalizeApiToken(apiToken: string | null | undefined): string | null {
  const trimmed = apiToken?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function parseBearerToken(value: string | undefined): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function authorizeMcpRequest(
  request: import("express").Request,
  response: import("express").Response,
  apiToken: string,
): boolean {
  const normalizedToken = normalizeApiToken(apiToken);
  const providedToken = parseBearerToken(request.get("authorization"));
  if (providedToken === normalizedToken) {
    return true;
  }

  response
    .status(401)
    .setHeader("WWW-Authenticate", 'Bearer realm="remcodex", charset="UTF-8"')
    .json(jsonRpcError(-32000, "Unauthorized"));
  return false;
}

function isBootstrapRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }

  const method = String((body as { method?: unknown }).method || "");
  return method === "initialize" || method === "server/discover";
}

function registerToolserver(
  server: McpServer,
  deps: RemCodexMcpDependencies,
) {
  server.registerTool(
    "list-profiles",
    {
      description: "List RemCodex agent profiles.",
      inputSchema: z.object({}),
    },
    async () => mcpJsonResult(deps.profileManager.listProfiles()),
  );

  server.registerTool(
    "get-profile",
    {
      description: "Get a RemCodex agent profile by id or name.",
      inputSchema: z.object({ profileId: z.string().min(1) }),
    },
    async ({ profileId }) => {
      const profile = deps.profileManager.getProfile(profileId);
      return profile ? mcpJsonResult(profile) : mcpErrorResult("Profile not found.");
    },
  );

  server.registerTool(
    "list-projects",
    {
      description: "List all RemCodex projects.",
      inputSchema: z.object({}),
    },
    async () =>
      mcpJsonResult(
        deps.projectManager.listProjects().map((project) => ({
          projectId: project.id,
          name: project.name,
          path: project.path,
          createdAt: project.created_at,
        })),
      ),
  );

  server.registerTool(
    "list-sessions",
    {
      description: "List RemCodex sessions.",
      inputSchema: z.object({}),
    },
    async () =>
      mcpJsonResult(
        deps.sessionManager.listSessions().map((session) =>
          serializeSessionListItem(
            session,
            deps.projectManager,
            deps.sessionManager.getPendingApproval(session.id),
          ),
        ),
      ),
  );

  server.registerTool(
    "list-sessions-by-directory",
    {
      description: "List all sessions previously started in a working directory.",
      inputSchema: z.object({
        workingDirectory: z.string().min(1),
      }),
    },
    async ({ workingDirectory }) =>
      mcpJsonResult(
        deps.sessionManager.listSessionsByProjectPath(workingDirectory).map((session) =>
          serializeSessionListItem(
            session,
            deps.projectManager,
            deps.sessionManager.getPendingApproval(session.id),
          ),
        ),
      ),
  );

  server.registerTool(
    "get-session",
    {
      description: "Get a single session by id.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
      }),
    },
    async ({ sessionId }) => {
      const session = deps.sessionManager.getSession(sessionId);
      if (!session) {
        return mcpErrorResult("Session not found.");
      }

      return mcpJsonResult(
        serializeSession(session, deps.projectManager, deps.sessionManager.getPendingApproval(sessionId)),
      );
    },
  );

  server.registerTool(
    "resume-session",
    {
      description: "Resume an existing session for continued work.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        parentSessionId: z.string().min(1).optional(),
      }),
    },
    async ({ sessionId, parentSessionId }) => {
      try {
        const session = deps.sessionManager.resumeSession(sessionId, parentSessionId);
        return mcpJsonResult({
          ...serializeSession(
            session,
            deps.projectManager,
            deps.sessionManager.getPendingApproval(session.id),
          ),
          resumed: true,
        });
      } catch (error) {
        return mcpErrorResult("Failed to resume session.", error instanceof Error ? error.message : error);
      }
    },
  );

  server.registerTool(
    "create-session",
    {
      description: "Find or create a session for a project or working directory.",
      inputSchema: z
        .object({
          projectId: z.string().min(1).optional(),
          workingDirectory: z.string().min(1).optional(),
          title: z.string().optional(),
          description: z.string().nullable().optional(),
          tags: z.array(z.string()).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          parentSessionId: z.string().min(1).optional(),
        })
        .refine(({ projectId, workingDirectory }) => projectId || workingDirectory, {
          message: "Either projectId or workingDirectory is required.",
        }),
    },
    async ({ projectId, workingDirectory, title, description, tags, metadata, parentSessionId }) => {
      try {
        const project = projectId
          ? deps.projectManager.getProject(projectId)
          : deps.projectManager.getOrCreateProjectByPath(
              workingDirectory ?? "",
              path.basename(path.resolve(workingDirectory ?? "")),
            );
        if (!project) {
          return mcpErrorResult("Project not found.");
        }
        if (
          workingDirectory &&
          path.resolve(project.path) !== path.resolve(workingDirectory)
        ) {
          return mcpErrorResult("Project and working directory do not refer to the same path.");
        }

        const reusableSession = parentSessionId
          ? null
          : deps.sessionManager.findSessionByProjectPath(project.path);
        const session =
          parentSessionId
            ? deps.sessionManager.createSession({
                projectId: project.id,
                title,
                description,
                tags,
                metadata,
                parentSessionId,
              })
            : reusableSession ??
              deps.sessionManager.createSession({ projectId: project.id, title, description, tags, metadata });
        return mcpJsonResult(
          {
            ...serializeSession(
              session,
              deps.projectManager,
              deps.sessionManager.getPendingApproval(session.id),
            ),
            reused: reusableSession?.id === session.id,
          },
        );
      } catch (error) {
        return mcpErrorResult("Failed to create session.", error instanceof Error ? error.message : error);
      }
    },
  );

  server.registerTool(
    "update-session-metadata",
    {
      description: "Update the description, tags, or metadata of an existing session.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        description: z.string().nullable().optional(),
        tags: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async ({ sessionId, description, tags, metadata }) => {
      try {
        const session = deps.sessionManager.updateSessionMetadata({
          sessionId,
          description,
          tags,
          metadata,
        });
        return mcpJsonResult(
          serializeSession(
            session,
            deps.projectManager,
            deps.sessionManager.getPendingApproval(session.id),
          ),
        );
      } catch (error) {
        return mcpErrorResult(
          "Failed to update session metadata.",
          error instanceof Error ? error.message : error,
        );
      }
    },
  );

  server.registerTool(
    "get-session-history",
    {
      description: "Get a timeline page for a session.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        after: z.number().int().nonnegative().optional(),
        before: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    },
    async ({ sessionId, after, before, limit }) => {
      try {
        const page = deps.sessionTimeline.list(sessionId, { after, before, limit });
        return mcpJsonResult(page);
      } catch (error) {
        return mcpErrorResult("Failed to load session history.", error instanceof Error ? error.message : error);
      }
    },
  );

  server.registerTool(
    "get-session-events",
    {
      description: "Get raw events for a session.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        after: z.number().int().nonnegative().optional(),
        before: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(1000).optional(),
      }),
    },
    async ({ sessionId, after, before, limit }) => {
      try {
        const page = deps.eventStore.list(sessionId, { after, before, limit });
        return mcpJsonResult(page);
      } catch (error) {
        return mcpErrorResult("Failed to load session events.", error instanceof Error ? error.message : error);
      }
    },
  );

  server.registerTool(
    "send-message",
    {
      description: "Send a chat message to a session.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        content: z.string().min(1),
        codex: z
          .object({
            modelId: z.string().optional(),
            reasoningId: z.string().optional(),
            profile: z.string().optional(),
          })
          .optional(),
      }),
    },
    async ({ sessionId, content, codex }) => {
      try {
        const result = deps.sessionManager.sendMessage(
          sessionId,
          content,
          normalizeCodexExecLaunchInput(codex),
        );
        return mcpJsonResult(result);
      } catch (error) {
        return mcpErrorResult("Failed to send message.", error instanceof Error ? error.message : error);
      }
    },
  );

  server.registerTool(
    "stop-session",
    {
      description: "Stop the active session runner.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
      }),
    },
    async ({ sessionId }) => {
      try {
        const result = deps.sessionManager.stopSession(sessionId);
        return mcpJsonResult(result);
      } catch (error) {
        return mcpErrorResult("Failed to stop session.", error instanceof Error ? error.message : error);
      }
    },
  );

  server.registerTool(
    "sync-imported-session",
    {
      description: "Sync an imported rollout session into the database.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
      }),
    },
    async ({ sessionId }) => {
      try {
        const result = deps.codexRolloutSync.syncImportedSession(sessionId);
        return mcpJsonResult(result);
      } catch (error) {
        return mcpErrorResult("Failed to sync imported session.", error instanceof Error ? error.message : error);
      }
    },
  );

  server.registerTool(
    "resolve-approval",
    {
      description: "Resolve a pending approval request for a session.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        requestId: z.string().min(1),
        decision: z.enum(["accept", "acceptForSession", "decline"]),
      }),
    },
    async ({ sessionId, requestId, decision }) => {
      try {
        const result = deps.sessionManager.resolveApproval(sessionId, requestId, decision);
        return mcpJsonResult(result);
      } catch (error) {
        return mcpErrorResult("Failed to resolve approval.", error instanceof Error ? error.message : error);
      }
    },
  );

  server.registerTool(
    "retry-approval",
    {
      description: "Retry a pending approval request for a session.",
      inputSchema: z.object({
        sessionId: z.string().min(1),
        requestId: z.string().min(1),
        codex: z
          .object({
            modelId: z.string().optional(),
            reasoningId: z.string().optional(),
            profile: z.string().optional(),
          })
          .optional(),
      }),
    },
    async ({ sessionId, requestId, codex }) => {
      try {
        const result = deps.sessionManager.retryApprovalRequest(
          sessionId,
          requestId,
          normalizeCodexExecLaunchInput(codex),
        );
        return mcpJsonResult(result);
      } catch (error) {
        return mcpErrorResult("Failed to retry approval.", error instanceof Error ? error.message : error);
      }
    },
  );
}

function buildMcpServer(deps: RemCodexMcpDependencies) {
  const server = new McpServer({
    name: "remcodex",
    version: "0.1.0-beta.12",
  });

  registerToolserver(server, deps);
  return server;
}

export async function handleRemCodexMcpRequest(
  request: import("express").Request,
  response: import("express").Response,
  deps: RemCodexMcpDependencies,
  options: RemCodexMcpRequestOptions,
): Promise<void> {
  if (!authorizeMcpRequest(request, response, options.apiToken)) {
    return;
  }

  const sessionId = String(request.headers["mcp-session-id"] || "").trim();

  if (request.method === "DELETE") {
    if (!sessionId || !sessions.has(sessionId)) {
      response.status(sessionId ? 404 : 400).json(
        sessionId ? jsonRpcError(-32001, "Session not found") : jsonRpcError(-32000, "Bad Request: Session ID required"),
      );
      return;
    }

    const entry = sessions.get(sessionId);
    sessions.delete(sessionId);
    await entry?.transport.close().catch(() => null);
    response.status(204).end();
    return;
  }

  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId)?.transport.handleRequest(request, response, request.body);
    return;
  }

  if (!sessionId && isBootstrapRequest(request.body)) {
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        sessions.set(id, { transport });
      },
    });

    const server = buildMcpServer(deps);
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
    return;
  }

  if (sessionId) {
    response.status(404).json(jsonRpcError(-32001, "Session not found"));
    return;
  }

  response.status(400).json(jsonRpcError(-32000, "Bad Request: Session ID required"));
}
