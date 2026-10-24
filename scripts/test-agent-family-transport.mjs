import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {createFamilyHandler} from './agent-family-http.mjs'
const calls=[]
const caps=new Map([['test-token','real-parent']])
const family={list:p=>[{room_id:'child',parent:p}],spawn:async(p,a)=>{calls.push([p,a]);return {room_id:'child'}},message:async(p,c,t)=>({parent:p,child:c,text:t})}
const server=createServer(createFamilyHandler(caps,family));await new Promise(r=>server.listen(0,'127.0.0.1',r))
const url=`http://127.0.0.1:${server.address().port}`
try {
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403)
 const res=await fetch(url,{method:'POST',headers:{authorization:'Bearer test-token'},body:JSON.stringify({name:'spawn_agent',arguments:{parent_room_id:'spoofed',task_key:'x'}})})
 assert.equal(res.status,200);assert.equal(calls[0][0],'real-parent')
 const proc=spawn(process.execPath,[new URL('./agent-family-mcp.mjs',import.meta.url).pathname],{env:{...process.env,AGENT_FAMILY_TOKEN:'test-token',AGENT_FAMILY_URL:url},stdio:['pipe','pipe','inherit']})
 let stdout='';proc.stdout.on('data',c=>stdout+=c)
 proc.stdin.end([
  {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}},
  {jsonrpc:'2.0',id:2,method:'tools/list'},
  {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_agents',arguments:{}}},
 ].map(x=>JSON.stringify(x)).join('\n')+'\n')
 await new Promise((resolve,reject)=>{proc.on('exit',c=>c===0?resolve():reject(Error(`MCP exit ${c}`)));proc.on('error',reject)})
 const messages=stdout.trim().split('\n').map(s=>JSON.parse(s))
 assert.equal(messages[1].result.tools.length,3)
 assert.equal(JSON.parse(messages[2].result.content[0].text)[0].parent,'real-parent')
 caps.clear()
 assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer test-token'},body:'{}'})).status,403)
 console.log('agent-family transport: actual stdio MCP ↔ HTTP; caller spoofing rejected; expired capabilities denied')
} finally {await new Promise(r=>server.close(r))}
