import { mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";

import { createCodexOptionsRouter } from "./controllers/codex-options.controller";
import { createMessageRouter } from "./controllers/message.controller";
import { createProjectRouter } from "./controllers/project.controller";
import { createSessionRouter } from "./controllers/session.controller";
import { createProfileRouter } from "./controllers/profile.controller";
import { handleRemCodexMcpRequest } from "./mcp";
import { createDatabase } from "./db/client";
import { runMigrations } from "./db/migrations";
import { registerSessionGateway } from "./gateways/ws.gateway";
import { EventStore } from "./services/event-store";
import { CodexRolloutSyncService } from "./services/codex-rollout-sync";
import { CodexAppServerRegistryService } from "./services/codex-app-server-registry";
import { ProjectManager } from "./services/project-manager";
import { AgentProfileManager } from "./services/agent-profile-manager";
import { SessionManager } from "./services/session-manager";
import { SpeechToTextService } from "./services/speech-to-text";
import { SessionTimelineService } from "./services/session-timeline-service";
import type { CodexExecutionMode } from "./services/codex-runner";
import { loadRemCodexConfig } from "./utils/remcodex-config";
import {
  resolveDefaultConfigPath,
  resolveDefaultDatabasePath,
  resolvePackageRoot,
} from "./utils/runtime-paths";
import { resolveExecutable } from "./utils/command";
import { isAppError } from "./utils/errors";
import {
  parseRemCodexDirectoryInstances,
  type RemCodexDirectoryInstance,
} from "./utils/remcodex-directory";

export interface RemCodexServerOptions {
  port?: number;
  databasePath?: string;
  configPath?: string;
  projectRootsEnv?: string;
  repoRoot?: string;
  codexCommand?: string;
  codexMode?: CodexExecutionMode;
  logStartup?: boolean;
  directoryInstances?: RemCodexDirectoryInstance[];
}

function resolveMcpApiToken(): string | null {
  const token = process.env.REMCODEX_MCP_API_TOKEN?.trim() || "";
  return token.length > 0 ? token : null;
}

export interface StartedRemCodexServer {
  app: express.Express;
  server: http.Server;
  port: number;
  repoRoot: string;
  databasePath: string;
  codexCommand: string;
  codexMode: CodexExecutionMode;
  projectRoots: string[];
  directoryInstances: RemCodexDirectoryInstance[];
  stop: () => Promise<void>;
}

interface BuiltRemCodexServer {
  app: express.Express;
  server: http.Server;
  closeDatabase: () => void;
  port: number;
  repoRoot: string;
  databasePath: string;
  codexCommand: string;
  codexMode: CodexExecutionMode;
  projectRoots: string[];
  logStartup: boolean;
  directoryInstances: RemCodexDirectoryInstance[];
}

function buildRemCodexServer(options: RemCodexServerOptions = {}): BuiltRemCodexServer {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : resolvePackageRoot();
  const port = options.port ?? Number.parseInt(process.env.PORT ?? "18840", 10);
  const databasePath =
    options.databasePath ??
    process.env.DATABASE_PATH ??
    resolveDefaultDatabasePath();
  const configPath =
    options.configPath ??
    process.env.REMCODEX_CONFIG_PATH ??
    resolveDefaultConfigPath();
  const codexCommand = resolveExecutable(options.codexCommand ?? process.env.CODEX_COMMAND ?? "codex");
  const codexMode: CodexExecutionMode =
    options.codexMode ?? (process.env.CODEX_MODE === "exec-json" ? "exec-json" : "app-server");
  const projectRootsEnv = options.projectRootsEnv ?? process.env.PROJECT_ROOTS;
  const directoryInstances = options.directoryInstances ?? parseRemCodexDirectoryInstances(
    process.env.REMCODEX_DIRECTORY_INSTANCES ?? "",
  );

  mkdirSync(path.dirname(databasePath), { recursive: true });

  const db = createDatabase(databasePath);
  runMigrations(db);

  const eventStore = new EventStore(db);
  const sessionTimeline = new SessionTimelineService(eventStore);
  const projectManager = new ProjectManager(db, projectRootsEnv, repoRoot);
  const remCodexConfig = loadRemCodexConfig(configPath);
  const profileManager = new AgentProfileManager(db, {
    initialProfiles: remCodexConfig.profiles,
  });
  const codexRolloutSync = new CodexRolloutSyncService(db);
  const appServerRegistry = new CodexAppServerRegistryService(codexRolloutSync);
  const speechToText = new SpeechToTextService({
    preferredBinary: process.env.REMCODEX_STT_BINARY,
    modelPath: process.env.REMCODEX_STT_MODEL_PATH,
  });
  const sessionManager = new SessionManager({
    db,
    eventStore,
    projectManager,
    codexCommand,
    codexMode,
  });
  const mcpApiToken = resolveMcpApiToken();

  const app = express();
  const server = http.createServer(app);

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/directory/instances", (_request, response) => {
    response.json({ items: directoryInstances });
  });

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      codexMode,
      codexCommand,
      projectRoots: projectManager.listAllowedRoots(),
      now: new Date().toISOString(),
    });
  });

  app.use("/api/projects", createProjectRouter(projectManager));
  app.use("/api/profiles", createProfileRouter(profileManager));
  app.use(
    "/api/codex",
    createCodexOptionsRouter({
      sessionManager,
      projectManager,
      eventStore,
      codexMode,
      codexRolloutSync,
    }),
  );
  app.use(
    "/api/sessions",
    createSessionRouter(
      sessionManager,
      eventStore,
      projectManager,
      codexRolloutSync,
      appServerRegistry,
      sessionTimeline,
    ),
  );
  app.use("/api/sessions/:sessionId/messages", createMessageRouter(sessionManager, speechToText));
  if (mcpApiToken) {
    app.all("/mcp", async (request, response, next) => {
      try {
        await handleRemCodexMcpRequest(
          request,
          response,
          {
            eventStore,
            projectManager,
            sessionManager,
            sessionTimeline,
            codexRolloutSync,
            profileManager,
          },
          {
            apiToken: mcpApiToken,
          },
        );
      } catch (error) {
        next(error);
      }
    });
  } else {
    app.all("/mcp", (_request, response) => {
      response.status(404).json({
        error: "MCP is disabled. Set REMCODEX_MCP_API_TOKEN to enable it.",
      });
    });
  }

  const webRoot = path.join(repoRoot, "web");
  app.use(express.static(webRoot));
  app.get(["/directory", "/directory/"], (_request, response) => {
    response.sendFile(path.join(webRoot, "directory.html"));
  });
  app.get("/", (_request, response) => {
    response.sendFile(path.join(webRoot, "index.html"));
  });

  app.use(
    (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
      if (isAppError(error)) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }

      const message = error instanceof Error ? error.message : "Internal server error";
      response.status(500).json({
        error: message,
      });
    },
  );

  registerSessionGateway(server, {
    eventStore,
    sessionManager,
  });

  return {
    app,
    server,
    closeDatabase: () => {
      const closable = db as typeof db & { close?: () => void };
      closable.close?.();
    },
    port,
    repoRoot,
    databasePath,
    codexCommand,
    codexMode,
    projectRoots: projectManager.listAllowedRoots(),
    directoryInstances,
    logStartup: options.logStartup ?? true,
  };
}

export async function startRemCodexServer(
  options: RemCodexServerOptions = {},
): Promise<StartedRemCodexServer> {
  const built = buildRemCodexServer(options);

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      built.server.off("listening", handleListening);
      reject(error);
    };

    const handleListening = () => {
      built.server.off("error", handleError);
      resolve();
    };

    built.server.once("error", handleError);
    built.server.once("listening", handleListening);
    built.server.listen(built.port);
  });

  if (built.logStartup) {
    console.log(
      JSON.stringify({
        message: "RemCodex listening",
        port: built.port,
        codexMode: built.codexMode,
        databasePath: built.databasePath,
        codexCommand: built.codexCommand,
        directoryInstances: built.directoryInstances.length,
      }),
    );
  }

  return {
    app: built.app,
    server: built.server,
    port: built.port,
    repoRoot: built.repoRoot,
    databasePath: built.databasePath,
    codexCommand: built.codexCommand,
    codexMode: built.codexMode,
    projectRoots: built.projectRoots,
    directoryInstances: built.directoryInstances,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        built.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          built.closeDatabase();
          resolve();
        });
      }),
  };
}

async function main() {
  await startRemCodexServer();
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        message: "Failed to start RemCodex",
        error: message,
      }),
    );
    process.exitCode = 1;
  });
}
