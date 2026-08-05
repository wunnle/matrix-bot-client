---
name: room-rename
description: Rename the Matrix agent room this conversation is running in, based on what the conversation has been about. Use when the user asks to rename the room, retitle the chat, or give the room a better name.
---

# Rename this agent room

Agent rooms are created as `BenderDev-<n>`. This renames the *current* room to
something that says what the work in it is actually about.

## Steps

1. Pick a name from the conversation so far - the task, not the tooling.
   - As short as it can be while staying unambiguous. Two words is the target,
     three is the limit, <= 24 chars. It is shown in a narrow room-list tile
     and is truncated there, so the first word has to carry the meaning.
   - Concrete and specific: `Approval hook`, not `Bot work`. Drop filler like
     "fix", "add", "work on", and any word the other one already implies.
   - Title case, no trailing punctuation, no `BenderDev-` prefix.
   - If several unrelated things happened, name the dominant one.
   - If the user supplied a name themselves, use it verbatim.
2. Rename:

   ```bash
   node ~/matrix-pwa/scripts/room-rename.mjs "Chosen Name"
   ```

3. Tell the user the new name in one line.

## Notes

- `AGENT_ROOM_ID` is set by `scripts/claude-code-bot.mjs` for every agent turn;
  the script reads it, so there is no room id to pass or guess. Outside an agent
  room the script exits with an error - that is expected.
- Auth is the bot's stored session (`scripts/.claude-bot-store/.session.json`).
  If it is missing or expired the script fails loudly; the bot must have logged
  in at least once.
- The bot only auto-renames rooms whose name still matches its legacy pattern,
  so a name set here survives restarts.
