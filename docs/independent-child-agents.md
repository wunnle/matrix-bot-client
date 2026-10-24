# Independent child agents

Claude rooms have a harness-owned `agent_rooms` stdio MCP server. This creates full persistent Matrix agent rooms, **not** native Claude subagents. Users can talk to each child directly. The provider session and Git worktree are separate; only a bounded brief crosses the boundary.

## Tools and policy

- `list_agents`: list the caller's direct children.
- `spawn_agent({task_key,title,prompt})`: create/reuse a child; the stable task key makes retried spawns idempotent.
- `message_agent({room_id,prompt})`: follow up with a direct child.

Standing instructions automatically delegate meaningful isolated work, reuse related child sessions, and keep tiny edits/coordination in the parent. The harness enforces two child levels, four active children per parent, and eight starting/working children globally. Each child inherits the provider/model and room encryption setting. Git isolation is mandatory; failure to cut a worktree aborts child creation rather than falling back to shared edits. The checkout starts from the parent's committed HEAD, **not uncommitted edits**. Commit prerequisites or give a research-only brief before delegating dependent work.

## Identity and UI

The bot session map stores `parentRoomId`, `rootRoomId`, task key, creation time, depth and status. `com.construct.agent.lineage` publishes only the display relationship and status; authorization never trusts client room state. Construct renders joined child rooms under their parent, with a parent label. The owner must accept the normal Matrix invitation before the room appears among joined agents.

The HTTP broker accepts a random capability scoped to one currently running turn. Room identity comes from the server-side capability map, never tool arguments. Capabilities expire when the turn ends. MCP credentials are inherited through the process environment, not command-line arguments.

## Results, recovery and quota

Each completed child **turn** posts a concise report (up to 3,000 characters) to its parent and appends it to the parent's inbox. `done` describes the end of that turn, not proof that every requested acceptance criterion passed. The worker must include actual verification and blockers; unmerged branches remain unmerged. These reports are evidence, not user instructions.

The parent model sees inbox reports on its **next natural turn**. Reporting does not automatically invoke another model request; this avoids quota-burning completion loops. Detailed tool history remains in the child.

Reports are persisted before answer publication or pending-task cleanup. A durable pending-report outbox and stable Matrix transaction ID retry delivery after restart without duplicating timeline reports. Task-key retries repair interrupted spawn publication. Session saves use atomic rename.

Known provider limits pause child work and preserve a pending prompt. Continue explicitly retries after the provider is available. Restart never automatically resumes paid work: interrupted children are paused with Continue. Recovery pauses and quota blocks have distinct state kinds, so interruption does not falsely block every room on the provider. The first real provider quota response is still needed to establish an unknown limit; this does not infer billing usage from token totals.

## Verification

`npm test` includes family lifecycle, quota/recovery/delivery failures, result-persistence ordering, parent-first tree rendering data, and actual local stdio-MCP-to-HTTP transport tests. The provider suite uses its existing explicit fake CLI fixture. These tests consume no Claude quota and do not claim to exercise a live Anthropic model.

Before release: `npm test`, `npm run build`, `git diff --check`; ensure the live bot has no active CLI children before restart. After release verify the supervisor, broker capability rejection and deployed client bundle. A real Claude parent→child→parent smoke test remains separate and requires available Claude quota.
