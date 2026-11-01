// Deploy grants: approving the deploy skill once covers that deploy's own steps.
//
// The commands a grant answers are decided in approval-rules.mjs
// (deployGrantCovers); this is only who holds one and for how long. Split out
// of claude-code-bot.mjs so it can be tested without logging into Matrix.
//
// A grant is narrow on purpose: one room, opened only by the owner approving a
// `deploy` Skill card, ended by the end of the turn or 15 minutes, whichever is
// first. It lives in memory and nowhere else, so a bot restart — which is how a
// deploy usually finishes — drops every grant rather than carrying one over.
import { deployGrantCovers } from './approval-rules.mjs'

export const DEPLOY_GRANT_MS = 15 * 60 * 1000

// What the deploy card's approve button says, so one tap says what it covers.
export const APPROVE_DEPLOY = 'Approve deploy (merge, push, restart)'

// The hook sends a Skill call's input along (see claude-approval-hook.mjs).
export function isDeploySkill(request) {
  return request?.toolName === 'Skill' && request.input?.skill === 'deploy'
}

export function createDeployGrants({ owner, ttlMs = DEPLOY_GRANT_MS, now = Date.now } = {}) {
  // roomId -> expiresAt.
  const grants = new Map()

  // Lapsed grants are cleared as they are read, like auto mode.
  function active(roomId) {
    const until = grants.get(roomId)
    if (until === undefined) return false
    if (now() >= until) {
      grants.delete(roomId)
      return false
    }
    return true
  }

  // Returns whether a grant was opened. Only the owner's approval opens one.
  function open(roomId, sender) {
    if (!owner || sender !== owner) return false
    grants.set(roomId, now() + ttlMs)
    return true
  }

  const end = (roomId) => grants.delete(roomId)

  // A Bash call, in this room, while the grant is open, of a shape it covers.
  function covers(roomId, request) {
    return request?.toolName === 'Bash' && active(roomId) && deployGrantCovers(request.summary, request.cwd)
  }

  return { open, end, active, covers }
}
