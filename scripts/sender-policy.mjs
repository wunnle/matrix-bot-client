// Who may make this bot do anything.
//
// matrix.org has open registration, so "anyone who can reach the bot" is
// anyone at all. Every rule here starts from the owner and widens only by name.
//
// Pure: callers pass in what they read off the room and act on the verdict.

/** AGENT_TRUSTED_SENDERS: comma-separated user ids allowed to start turns
    alongside the owner — another bot relaying a prompt into an agent room.
    They can never answer approvals or questions. */
export function parseTrusted(value) {
  return new Set(String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean))
}

/** An invite is accepted only from the owner or a trusted sender. An unknown
    inviter is refused: stripped invite state normally names them, and a room
    that hides who asked is not one to join on faith. */
export function inviteAllowed(inviter, { owner, trusted = new Set() }) {
  if (!owner) return true
  if (!inviter) return false
  return inviter === owner || trusted.has(inviter)
}

/** May this message start or steer a turn? */
export function mayPrompt(sender, { owner, trusted = new Set() }) {
  if (!owner) return true
  return sender === owner || trusted.has(sender)
}

/** May this message answer an approval card or a provider question? These
    decide what the agent is allowed to do, so only the owner answers them. */
export function mayAnswer(sender, { owner }) {
  return !owner || sender === owner
}

/** A room counts as an agent room by its m.room.create marker only when this
    bot created it. The `type` is whatever the creator chose, so anyone could
    make a room carrying it and invite the bot in. */
export function isOwnAgentRoom(createEvent, { botId, roomType }) {
  if (!createEvent) return false
  return createEvent.getContent()?.type === roomType && createEvent.getSender() === botId
}
