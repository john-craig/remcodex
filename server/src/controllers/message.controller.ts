import express, { Router } from "express";

import { SessionManager } from "../services/session-manager";
import { SpeechToTextService } from "../services/speech-to-text";
import { normalizeCodexExecLaunchInput } from "../utils/codex-launch";
import { AppError } from "../utils/errors";

export function createMessageRouter(
  sessionManager: SessionManager,
  speechToText: SpeechToTextService,
): Router {
  const router = Router({ mergeParams: true });

  router.post(
    "/voice",
    express.raw({ type: ["audio/*", "application/octet-stream"], limit: "25mb" }),
    (request, response, next) => {
      try {
        if (!speechToText.isAvailable()) {
          throw new AppError(
            503,
            "Voice transcription is unavailable. Install a whisper CLI or configure REMCODEX_STT_BINARY.",
          );
        }

        if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
          throw new AppError(400, "Voice note audio is required.");
        }

        const params = request.params as { sessionId: string };
        const launch = normalizeCodexExecLaunchInput({
          model: request.header("x-codex-model") ?? undefined,
          reasoningEffort: request.header("x-codex-reasoning") ?? undefined,
          profile: request.header("x-codex-profile") ?? undefined,
        });
        const transcript = speechToText.transcribe(
          request.body,
          request.header("content-type"),
          request.header("x-filename"),
        );
        const result = sessionManager.sendMessage(params.sessionId, transcript, launch);

        response.json({
          ...result,
          transcript,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.post("/", (request, response, next) => {
    try {
      const body = request.body as { content?: string; codex?: unknown };
      const params = request.params as { sessionId: string };
      const launch = normalizeCodexExecLaunchInput(body.codex);
      const result = sessionManager.sendMessage(params.sessionId, body.content ?? "", launch);

      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
