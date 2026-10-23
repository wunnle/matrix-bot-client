import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const bot=readFileSync(new URL('./claude-code-bot.mjs',import.meta.url),'utf8')
const normalOutcome=bot.slice(bot.indexOf('const block = detectLimitBlock(res)'),bot.indexOf('// !stop drops the queue too:'))
assert.ok(normalOutcome.indexOf("res.error ? 'failed' : 'done'") < normalOutcome.indexOf('delete sessions[roomId].pendingPrompt'), 'persist computed result before clearing recovery work')
assert.match(normalOutcome,/if \(!modelOutcomeRecorded\)/,'a post-result Matrix failure must not overwrite the computed outcome')
console.log('agent outcome ordering: durable report before answer publication and recovery cleanup')
