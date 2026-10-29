import assert from 'node:assert/strict'
import { createAgentFamily, createParentWaker, WAKE_PROMPT } from './agent-family.mjs'
import { isQuotaBlockedState } from './limit-block.mjs'
assert.equal(isQuotaBlockedState({blocked:true,kind:'paused',reason:'interrupted restart'}),false)
assert.equal(isQuotaBlockedState({blocked:true,kind:'quota',reason:'limit'}),true)
assert.equal(isQuotaBlockedState({blocked:true,reason:'Claude AI usage limit reached'}),true)
assert.equal(isQuotaBlockedState({blocked:true,reason:'Agent interrupted by a service restart'}),false)
const sessions = { parent: { cwd: '/repo', model: 'opus', provider: 'claude' } }
const events = []; const runs = []; const paused = []; let saves = 0; let n = 0
const family = createAgentFamily({ sessions, save: () => saves++,
  spawn: async (parent, task) => ({ room_id: `child-${++n}`, cwd: '/isolated', model: parent.model, provider: parent.provider }),
  publish: async (id, content) => events.push({ id, content }),
  notify: async (id, text) => events.push({ id, text }),
  start: (id, prompt) => runs.push({ id, prompt }), pause: async id => paused.push(id), isBlocked: () => true,
})
const child = await family.spawn('parent', { task_key: 'auth', title: 'Auth investigation', prompt: 'Find the bug' })
assert.equal(child.parent_room_id, 'parent')
assert.equal(sessions[child.room_id].parentRoomId, 'parent')
assert.equal(sessions[child.room_id].rootRoomId, 'parent')
assert.equal(runs.length, 0, 'known quota block must not launch Claude')
assert.equal(sessions[child.room_id].pendingPrompt, 'Find the bug')
assert.equal(child.status, 'blocked')
assert.deepEqual(paused, [child.room_id], 'paused children expose Continue without a model request')
await family.message('parent', child.room_id, 'Also check token expiry')
assert.equal(runs.length, 0, 'follow-ups must respect known provider limits')
assert.match(sessions[child.room_id].pendingPrompt, /Find the bug[\s\S]*Also check token expiry/)
assert.equal((await family.spawn('parent', { task_key: 'auth', title: 'Again', prompt: 'duplicate' })).room_id, child.room_id)
assert.equal(n, 1, 'retries reuse a task-keyed child')
await assert.rejects(() => family.message('parent', 'unrelated', 'hello'), /direct child/)
await family.report(child.room_id, 'done', 'Found the bug; tests pass')
assert.equal(sessions.parent.agentReports.length, 1)
assert.match(sessions.parent.agentReports[0].summary, /tests pass/)
assert.equal(sessions[child.room_id].agentStatus, 'done')
assert.ok(events.some(e => e.id === 'parent' && e.text?.includes('tests pass')))
const recoveredSessions = JSON.parse(JSON.stringify(sessions))
recoveredSessions[child.room_id].agentStatus = 'working'
recoveredSessions[child.room_id].pendingPrompt = 'Interrupted task'
const recoveryPauses = []
const restarted = createAgentFamily({ sessions: recoveredSessions, save() {}, publish: async()=>{}, notify: async()=>{}, start() {throw Error('Recovery must not consume model quota')}, pause: async id => recoveryPauses.push(id), spawn: async()=>{throw Error('must reuse')} })
await restarted.recover()
assert.equal(recoveredSessions[child.room_id].agentStatus, 'stopped')
assert.equal(recoveredSessions[child.room_id].pendingPrompt, 'Interrupted task')
assert.deepEqual(recoveryPauses, [child.room_id])
assert.equal((await restarted.spawn('parent', {task_key:'auth', title:'Auth', prompt:'retry'})).room_id, child.room_id)
assert.ok(saves > 0)
// A network failure must not lose an already-computed child result.
let deliveryFails = true
const durable = { root: {}, worker: {parentRoomId:'root',agentTitle:'Worker'} }
const delivered = []
const makeDelivery = () => createAgentFamily({sessions:durable,save(){},spawn(){},start(){},publish:async()=>{},notify:async(id,text,txn)=>{
  if (deliveryFails) throw Error('homeserver offline')
  delivered.push({id,text,txn})
}})
await assert.rejects(() => makeDelivery().report('worker','done','Verified result'), /offline/)
assert.equal(durable.root.agentReports.length,1)
assert.ok(durable.worker.pendingAgentReport)
deliveryFails=false
await makeDelivery().recover()
assert.equal(delivered.length,1)
assert.match(delivered[0].text,/Verified result/)
assert.ok(delivered[0].txn)
assert.equal(durable.worker.pendingAgentReport,undefined)
// A transient announcement failure is repairable by the same task key, without a duplicate room.
let brokenPublication = true; let roomCreates = 0; let childStarts = 0
const repairSessions = {parent:{provider:'claude'}}
const repair = createAgentFamily({sessions:repairSessions,save(){},spawn:async()=>({room_id:`repair-${++roomCreates}`}),publish:async()=>{if(brokenPublication) throw Error('temporary publication failure')},notify:async()=>{},start(){childStarts++}})
await assert.rejects(()=>repair.spawn('parent',{task_key:'repair',title:'Repair',prompt:'Investigate'}),/publication/)
brokenPublication = false
await repair.spawn('parent',{task_key:'repair',title:'Repair',prompt:'Investigate'})
assert.equal(roomCreates,1)
assert.equal(childStarts,1)
// Finished children wake the parent; progress and user stops do not.
const wakeSessions = {lead:{}, a:{parentRoomId:'lead',agentTitle:'A'}, b:{parentRoomId:'lead',agentTitle:'B'}}
const woken = []
const waking = createAgentFamily({sessions:wakeSessions,save(){},spawn(){},start(){},publish:async()=>{},notify:async()=>{},wake:id=>woken.push(id)})
await waking.working('a')
await waking.report('a','stopped','Stopped by the user.')
assert.deepEqual(woken,[],'working updates and stops never wake the parent')
assert.equal(wakeSessions.lead.agentWakePending,undefined)
await waking.report('a','done','A finished')
await waking.report('b','failed','B broke')
assert.deepEqual(woken,['lead','lead'])
assert.equal(wakeSessions.lead.agentWakePending,true,'pending wake is persisted with the report')
const flaky = createAgentFamily({sessions:wakeSessions,save(){},spawn(){},start(){},publish:async()=>{},notify:async()=>{throw Error('offline')},wake:id=>woken.push(id)})
await assert.rejects(()=>flaky.report('b','blocked','Quota'),/offline/)
assert.equal(woken.length,3,'a failed notice still wakes the parent')
// A room the bot is resuming after a restart is not paused by recovery.
const resumed = {lead:{}, mid:{parentRoomId:'lead',agentStatus:'working'}, idle:{parentRoomId:'lead',agentStatus:'working'}}
const resumePauses = []
await createAgentFamily({sessions:resumed,save(){},spawn(){},start(){},publish:async()=>{},notify:async()=>{},pause:async id=>resumePauses.push(id)}).recover({resuming:new Set(['mid'])})
assert.deepEqual(resumePauses,['idle'])
assert.equal(resumed.mid.agentStatus,'working')
// The waker batches close reports, never starts a busy room, and skips a room blocked on the user.
const tick = ms => new Promise(r => setTimeout(r, ms))
const ws = {p:{agentWakePending:true}, q:{agentWakePending:true}, r:{agentWakePending:true}}
const busyRooms = new Set(['q']); const blockedRooms = new Set(['r']); const wakeStarts = []
const waker = createParentWaker({sessions:ws,save(){},delayMs:20,isBusy:id=>busyRooms.has(id),isBlocked:id=>blockedRooms.has(id),start:(id,prompt)=>wakeStarts.push({id,prompt})})
waker.schedule('p'); await tick(5); waker.schedule('p')
waker.schedule('q'); waker.schedule('r')
assert.equal(waker.take('q'),null,'a debouncing wake waits for its timer')
await tick(40)
assert.deepEqual(wakeStarts.map(s=>s.id),['p'],'two close reports start one turn; busy and blocked rooms are not started')
assert.equal(wakeStarts[0].prompt,WAKE_PROMPT)
assert.equal(waker.take('q'),WAKE_PROMPT,'a busy parent runs the wake as its next turn')
assert.equal(ws.r.agentWakePending,undefined,'a parent blocked on the user keeps its reports for its next turn')
ws.p.agentWakePending = false
waker.schedule('p'); await tick(40)
assert.equal(wakeStarts.length,1,'a turn that already carried the reports cancels the wake')
console.log('agent-family: persistent lineage, idempotency, quota pause, authorization, recovery, reports and parent wakes OK')
