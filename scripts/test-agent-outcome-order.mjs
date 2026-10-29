import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const bot=readFileSync(new URL('./claude-code-bot.mjs',import.meta.url),'utf8')
const normalOutcome=bot.slice(bot.indexOf('const block = detectLimitBlock(res)'),bot.indexOf('// !stop drops the queue too:'))
assert.ok(normalOutcome.indexOf("res.error ? 'failed' : 'done'") < normalOutcome.indexOf('delete sessions[roomId].pendingPrompt'), 'persist computed result before clearing recovery work')
assert.match(normalOutcome,/if \(!modelOutcomeRecorded\)/,'a post-result Matrix failure must not overwrite the computed outcome')
const drain=bot.slice(bot.indexOf('async function drainRoom('),bot.indexOf('// Resolves once an encrypted event has been decrypted'))
assert.ok(drain.indexOf('parentWaker.take(roomId)') < drain.indexOf('} finally {'),'a wake becomes the next turn of the same drain, never a second one')
assert.ok(drain.lastIndexOf('delete sessions[roomId].turnRunning') > drain.indexOf('} finally {'),'only a turn that ran to completion clears its restart marker')
assert.ok(bot.indexOf('const interrupted =') < bot.indexOf('await agentFamily.recover('),'interrupted turns are read before recovery pauses children')
assert.ok(bot.lastIndexOf('resumeInterruptedTurns()') > bot.lastIndexOf('startApprovalBroker()'),'resumed turns can ask for approvals')
console.log('agent outcome ordering: durable report before answer publication and recovery cleanup; wakes and restart resumes stay serial')
