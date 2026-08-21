import type { Response } from "express";

import {
  remoteMcpUrl,
  resolveRemCodexRemoteInstance,
  type RemCodexRemoteInstance,
} from "../utils/remcodex-remote-instances";

type RemoteFetch = typeof fetch;

function extractEventBody(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith("data: "));
  return line ? line.slice("data: ".length) : text;
}

async function post(
  url: string,
  authorization: string,
  body: unknown,
  sessionId: string | null,
  fetchImpl: RemoteFetch,
): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    authorization,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body) });
}

export async function proxyRemoteMcpCall(
  body: { id?: unknown; params?: { arguments?: Record<string, unknown> } },
  instances: RemCodexRemoteInstance[],
  callerResponse: Response,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: RemoteFetch = fetch,
): Promise<void> {
  const argumentsValue = body.params?.arguments ?? {};
  const instanceName = typeof argumentsValue.instanceName === "string" ? argumentsValue.instanceName : "";
  const { instance, authorization } = resolveRemCodexRemoteInstance(instanceName, instances, environment);
  const targetUrl = remoteMcpUrl(instance);
  const initialize = await post(
    targetUrl,
    authorization,
    {
      jsonrpc: "2.0",
      id: "remcodex-proxy-init",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "remcodex-proxy", version: "1" } },
    },
    null,
    fetchImpl,
  );
  if (!initialize.ok) throw new Error(`Remote instance initialization failed (${initialize.status}).`);
  const targetSessionId = initialize.headers.get("mcp-session-id");
  if (!targetSessionId) throw new Error("Remote instance did not return an MCP session.");

  await post(targetUrl, authorization, { jsonrpc: "2.0", method: "notifications/initialized" }, targetSessionId, fetchImpl);
  const forwardedArguments = { ...argumentsValue };
  delete forwardedArguments.instanceName;
  const remoteResponse = await post(
    targetUrl,
    authorization,
    { ...body, params: { ...(body.params ?? {}), arguments: forwardedArguments } },
    targetSessionId,
    fetchImpl,
  );
  const responseText = await remoteResponse.text();
  callerResponse.status(remoteResponse.status);
  callerResponse.setHeader("content-type", remoteResponse.headers.get("content-type") ?? "application/json");
  callerResponse.send(extractEventBody(responseText));
}
