import assert from 'node:assert/strict'
import { agentTree } from '../src/lib/agentTree.js'
const rooms=[{roomId:'b',parentAgentRoomId:'a'},{roomId:'c',parentAgentRoomId:'b'},{roomId:'a'},{roomId:'orphan',parentAgentRoomId:'gone'}]
assert.deepEqual(agentTree(rooms).map(r=>[r.roomId,r.agentTreeDepth]),[['a',0],['b',1],['c',2],['orphan',0]])
assert.equal(agentTree([{roomId:'a',parentAgentRoomId:'b'},{roomId:'b',parentAgentRoomId:'a'}]).length,2)
console.log('agent tree: parent-first nesting, orphans and cycles OK')
