import assert from "node:assert/strict";
import test from "node:test";

import { composeMessageContentWithStartingPrompt } from "../web/utils/session-starting-prompt.js";

test("starting prompt is prepended to the first submitted message", () => {
  assert.equal(
    composeMessageContentWithStartingPrompt(
      "Inspect the current session state.",
      "Use RemCodex to keep the workspace in view.",
    ),
    "Use RemCodex to keep the workspace in view.\n\nInspect the current session state.",
  );
});

test("starting prompt is ignored when no prompt is configured", () => {
  assert.equal(
    composeMessageContentWithStartingPrompt("Inspect the current session state.", ""),
    "Inspect the current session state.",
  );
});
