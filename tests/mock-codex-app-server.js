#!/usr/bin/env node

const readline = require("node:readline");

const chunkDelayMs = readPositiveInt(process.env.MOCK_CODEX_CHUNK_DELAY_MS, 8);
const chunkCount = readPositiveInt(process.env.MOCK_CODEX_CHUNK_COUNT, 6);

let nextThreadId = 1;
let nextTurnId = 1;
let nextMessageId = 1;

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  void handleLine(line);
});

rl.on("close", () => {
  process.exit(0);
});

function readPositiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function notify(method, params) {
  send({
    jsonrpc: "2.0",
    method,
    params,
  });
}

async function handleLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) {
    return;
  }

  let message = null;
  try {
    message = JSON.parse(trimmed);
  } catch (error) {
    process.stderr.write(`mock-codex: failed to parse input: ${error.message}\n`);
    return;
  }

  if (!message || typeof message !== "object") {
    return;
  }

  const method = typeof message.method === "string" ? message.method : "";
  const id = Number.isFinite(message.id) ? message.id : null;
  const params = message.params && typeof message.params === "object" ? message.params : {};

  if (method === "initialize" && id !== null) {
    respond(id, {
      protocolVersion: "2025-01-01",
      serverInfo: {
        name: "mock-codex-app-server",
        version: "0.0.0-test",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    return;
  }

  if (method === "initialized") {
    return;
  }

  if ((method === "thread/start" || method === "thread/resume") && id !== null) {
    const threadId =
      method === "thread/resume" && typeof params.threadId === "string" && params.threadId.trim()
        ? params.threadId.trim()
        : `mock-thread-${nextThreadId++}`;
    respond(id, {
      thread: {
        id: threadId,
      },
    });
    notify("thread/started", {
      thread: {
        id: threadId,
      },
    });
    return;
  }

  if (method === "turn/start" && id !== null) {
    const threadId =
      typeof params.threadId === "string" && params.threadId.trim()
        ? params.threadId.trim()
        : `mock-thread-${nextThreadId++}`;
    const prompt = readPromptText(params);
    const turnId = `mock-turn-${nextTurnId++}`;
    const messageId = `mock-message-${nextMessageId++}`;

    respond(id, {
      turn: {
        id: turnId,
        status: "running",
      },
    });

    void emitTurn(threadId, turnId, messageId, prompt);
    return;
  }

  if (id !== null) {
    respond(id, {});
  }
}

function readPromptText(params) {
  const input = Array.isArray(params.input) ? params.input : [];
  const first = input.find((item) => item && typeof item === "object" && item.type === "text");
  if (first && typeof first.text === "string" && first.text.trim()) {
    return first.text.trim();
  }

  return "empty prompt";
}

function buildReplyText(turnId, prompt) {
  return `Mock reply ${turnId}: ${prompt}`;
}

function splitIntoChunks(text, count) {
  const safeText = String(text || "");
  if (!safeText) {
    return [""];
  }

  const chunkSize = Math.max(1, Math.ceil(safeText.length / Math.max(1, count)));
  const parts = [];
  for (let index = 0; index < safeText.length; index += chunkSize) {
    parts.push(safeText.slice(index, index + chunkSize));
  }
  return parts;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function emitTurn(threadId, turnId, messageId, prompt) {
  const replyText = buildReplyText(turnId, prompt);
  const chunks = splitIntoChunks(replyText, chunkCount);

  notify("turn/started", {
    threadId,
    turn: {
      id: turnId,
      status: "running",
    },
  });

  notify("item/started", {
    turnId,
    item: {
      id: messageId,
      type: "agentMessage",
      phase: "final_answer",
      content: [],
    },
  });

  for (const chunk of chunks) {
    await delay(chunkDelayMs);
    notify("item/agentMessage/delta", {
      turnId,
      messageId,
      phase: "final_answer",
      delta: chunk,
    });
  }

  notify("item/completed", {
    turnId,
    item: {
      id: messageId,
      type: "agentMessage",
      phase: "final_answer",
      text: replyText,
      content: [
        {
          type: "text",
          text: replyText,
        },
      ],
      finishReason: "stop",
    },
  });

  notify("turn/completed", {
    turnId,
    turn: {
      id: turnId,
      status: "completed",
    },
  });
}
