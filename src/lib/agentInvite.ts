// Kept free of imports so scripts/test-agent-invite.mjs can load it under plain
// node, without the SDK or Vite's import.meta.env.

export interface InviteFacts {
  /** `type` from the invite's stripped m.room.create. */
  createType: unknown
  /** Who created the room: the stripped m.room.create's sender. */
  createSender: string | undefined
  /** Who invited us: the sender of our own m.room.member invite. */
  inviter: string | undefined
}

/**
 * Is this invite one to join without asking? Only an agent room the bot both
 * created and invited us to. The room type alone proves nothing — anyone can
 * create a room carrying it and invite the user — so the bot's id is pinned
 * rather than inferred. Mirrors isOwnAgentRoom in scripts/sender-policy.mjs.
 */
export function isBotAgentInvite(
  { createType, createSender, inviter }: InviteFacts,
  { botId, roomType }: { botId: string, roomType: string },
): boolean {
  if (!botId) return false
  return createType === roomType && createSender === botId && inviter === botId
}
