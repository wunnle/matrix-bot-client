# Codex Rooms Hardening Implementation Plan

> **For Hermes:** Execute this plan directly in the current room; do not delegate or use Kanban.

**Goal:** Bring Codex-backed Matrix agent rooms to practical parity with Claude rooms for resilience, visible progress, and human interaction.

**Architecture:** Keep the existing provider abstraction and shared `codex app-server`, but make the transport lifecycle generation-safe and testable. Translate Codex tool notifications into the existing Construct tool-progress event format, and route `request_user_input` through a dedicated per-room question queue so answers bypass the busy turn queue. Continue to fail closed for permission-profile and MCP elicitation requests because they grant capabilities that cannot be represented safely as ordinary chat approval.

**Tech Stack:** Node.js ESM, Codex app-server JSON-RPC, matrix-js-sdk, Construct custom Matrix event fields.

---

### Task 1: Extract and test Codex protocol behavior

**Files:**
- Modify: `scripts/providers/codex.mjs`
- Create: `scripts/test-codex-provider.mjs`
- Modify: `package.json`

1. Add tests for translating `item/started` notifications into concise tool-progress records.
2. Run the focused test and verify RED.
3. Export the minimal pure translator and implement it.
4. Verify GREEN.
5. Add tests for converting structured user-input questions and answers to the current protocol response shape.
6. Repeat RED/GREEN.

### Task 2: Add room-native user questions

**Files:**
- Create: `scripts/question-queue.mjs`
- Create: `scripts/test-question-queue.mjs`
- Modify: `scripts/claude-code-bot.mjs`
- Modify: `scripts/providers/codex.mjs`
- Modify: `package.json`

1. Test a per-room queue that presents one question at a time, accepts option labels or free text, times out safely, and drops queued questions on stop/reset/end.
2. Verify RED, implement minimally, verify GREEN.
3. Add a `question.ask` callback to provider turns.
4. Handle `item/tool/requestUserInput` by asking in Matrix and returning `{answers:{id:{answers:[...]}}}`.
5. Ensure question answers are consumed before the room's busy-message queue.
6. Keep secrets unsupported and fail closed with a clear note.

### Task 3: Publish Codex tool progress

**Files:**
- Modify: `scripts/providers/codex.mjs`
- Modify: `scripts/claude-code-bot.mjs`

1. Add an `onProgress` provider callback.
2. Translate command, file-change, web-search, and MCP/tool item starts into concise progress records.
3. Publish them as machine-marked `com.construct.tool_progress` messages so Construct's existing activity UI and grouping work without push/unread noise.
4. Deduplicate repeated started/completed notifications by item id.
5. Verify with focused tests.

### Task 4: Harden app-server lifecycle

**Files:**
- Modify: `scripts/providers/codex.mjs`
- Modify: `scripts/test-codex-provider.mjs`

1. Add tests for stale child exit events not tearing down a newer connection.
2. Verify RED.
3. Guard lifecycle handlers with a child generation/token.
4. Reject outstanding requests and turns exactly once on real disconnect.
5. Update protocol-version comments to reflect the generated 0.147.0 schema verification.
6. Verify GREEN.

### Task 5: Verification and deployment

**Files:**
- Review all changed files.

1. Run focused tests.
2. Run `npm test`.
3. Run `npm run build`.
4. Run syntax checks.
5. Perform an independent diff review and fix blocking findings.
6. Restart `claude-code-bot.service`.
7. Verify service health, Codex login, app-server startup, and no startup errors.
8. Commit the verified changes. Do not push unless explicitly requested.
