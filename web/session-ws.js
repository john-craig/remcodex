export function connectSessionSocket(sessionId, handlers) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws/sessions/${sessionId}`);

  ws.addEventListener("open", () => {
    handlers.onLog?.({
      level: "info",
      message: "Session websocket opened",
      details: {
        sessionId,
      },
    });
    handlers.onStateChange?.("open");
  });

  ws.addEventListener("close", () => {
    handlers.onLog?.({
      level: "info",
      message: "Session websocket closed",
      details: {
        sessionId,
      },
    });
    handlers.onStateChange?.("closed");
  });

  ws.addEventListener("error", () => {
    handlers.onLog?.({
      level: "error",
      message: "Session websocket error",
      details: {
        sessionId,
      },
    });
    handlers.onStateChange?.("error");
  });

  ws.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);
      handlers.onEvent?.(payload);
    } catch (error) {
      handlers.onLog?.({
        level: "warn",
        message: "Failed to parse websocket message",
        details: {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
          dataLength: typeof event.data === "string" ? event.data.length : null,
        },
      });
      handlers.onStateChange?.(error instanceof Error ? error.message : "parse_error");
    }
  });

  return {
    close() {
      ws.close();
    },
  };
}
