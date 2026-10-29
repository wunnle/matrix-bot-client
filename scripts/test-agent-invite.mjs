// Which invites the client accepts on its own (src/lib/agentInvite.ts).
// Run: node scripts/test-agent-invite.mjs
import assert from 'node:assert/strict'
import { isBotAgentInvite } from '../src/lib/agentInvite.ts'

const opts = { botId: '@bot:matrix.org', roomType: 'com.construct.agent' }
const invite = (over = {}) => ({
  createType: 'com.construct.agent',
  createSender: '@bot:matrix.org',
  inviter: '@bot:matrix.org',
  ...over,
})

assert.equal(isBotAgentInvite(invite(), opts), true)
// A stranger copying the room type, as creator, inviter, or both.
assert.equal(isBotAgentInvite(invite({ createSender: '@stranger:matrix.org' }), opts), false)
assert.equal(isBotAgentInvite(invite({ inviter: '@stranger:matrix.org' }), opts), false)
assert.equal(isBotAgentInvite(invite({ createSender: '@x:matrix.org', inviter: '@x:matrix.org' }), opts), false)
// The bot inviting to an ordinary room is still a manual Accept.
assert.equal(isBotAgentInvite(invite({ createType: undefined }), opts), false)
assert.equal(isBotAgentInvite(invite({ createType: 'm.space' }), opts), false)
// Stripped state not in yet: wait for a later sync rather than guess.
assert.equal(isBotAgentInvite(invite({ createType: undefined, createSender: undefined }), opts), false)
assert.equal(isBotAgentInvite(invite({ inviter: undefined }), opts), false)
// An empty configured id trusts nobody, not an absent sender.
assert.equal(isBotAgentInvite(invite({ createSender: '', inviter: '' }), { ...opts, botId: '' }), false)

console.log('agent invite trust passed')
