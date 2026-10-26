import assert from 'node:assert/strict'
import { parseTrusted, inviteAllowed, mayPrompt, mayAnswer, isOwnAgentRoom } from './sender-policy.mjs'

const owner = '@wunnle:matrix.org'
const trusted = parseTrusted(' @donbot_wunnle:matrix.org, ,@other:matrix.org ')
const policy = { owner, trusted }
assert.deepEqual([...trusted], ['@donbot_wunnle:matrix.org', '@other:matrix.org'])
assert.equal(parseTrusted(undefined).size, 0)

// Invites: owner and trusted only; an unknown inviter is refused.
assert.equal(inviteAllowed(owner, policy), true)
assert.equal(inviteAllowed('@donbot_wunnle:matrix.org', policy), true)
assert.equal(inviteAllowed('@stranger:matrix.org', policy), false)
assert.equal(inviteAllowed(undefined, policy), false)
assert.equal(inviteAllowed('@stranger:matrix.org', { owner }), false)

// Prompts: owner and trusted. Answers: owner only.
assert.equal(mayPrompt(owner, policy), true)
assert.equal(mayPrompt('@donbot_wunnle:matrix.org', policy), true)
assert.equal(mayPrompt('@stranger:matrix.org', policy), false)
assert.equal(mayAnswer(owner, policy), true)
assert.equal(mayAnswer('@donbot_wunnle:matrix.org', policy), false)
assert.equal(mayAnswer('@stranger:matrix.org', policy), false)

// No owner configured keeps the old open behaviour.
assert.equal(inviteAllowed('@stranger:matrix.org', { owner: '' }), true)
assert.equal(mayPrompt('@stranger:matrix.org', { owner: '' }), true)
assert.equal(mayAnswer('@stranger:matrix.org', { owner: '' }), true)

// The agent-room marker counts only on a room this bot created.
const create = (type, sender) => ({ getContent: () => ({ type }), getSender: () => sender })
const opts = { botId: '@bot:matrix.org', roomType: 'com.construct.agent' }
assert.equal(isOwnAgentRoom(create('com.construct.agent', '@bot:matrix.org'), opts), true)
assert.equal(isOwnAgentRoom(create('com.construct.agent', '@stranger:matrix.org'), opts), false)
assert.equal(isOwnAgentRoom(create(undefined, '@bot:matrix.org'), opts), false)
assert.equal(isOwnAgentRoom(undefined, opts), false)

console.log('sender-policy: ok')
