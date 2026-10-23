// Minimal newline-delimited stdio MCP transport. No credentials on argv or stdout.
import * as readline from 'node:readline'
const tools = [
  {name:'spawn_agent', description:'Create a full independent child agent room, automatically for meaningful isolatable work. Reuse a stable task_key. Returns immediately; completion is reported to your room.', inputSchema:{type:'object',properties:{task_key:{type:'string'},title:{type:'string'},prompt:{type:'string'}},required:['task_key','title','prompt'],additionalProperties:false}},
  {name:'list_agents', description:'List your persistent direct child agents before creating or reusing one.', inputSchema:{type:'object',properties:{},additionalProperties:false}},
  {name:'message_agent', description:'Give a direct child a follow-up brief. The user can also talk to it directly.', inputSchema:{type:'object',properties:{room_id:{type:'string'},prompt:{type:'string'}},required:['room_id','prompt'],additionalProperties:false}},
]
const input = readline.createInterface({input:process.stdin})
for await (const line of input) {
  let req
  try {req=JSON.parse(line)} catch {continue}
  if (req.id === undefined) continue
  const respond = (result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\n')
  try {
    if (req.method === 'initialize') respond({protocolVersion:req.params?.protocolVersion ?? '2024-11-05',capabilities:{tools:{}},serverInfo:{name:'agent_rooms',version:'1.0.0'}})
    else if (req.method === 'ping') respond({})
    else if (req.method === 'tools/list') respond({tools})
    else if (req.method === 'tools/call') {
      if (!tools.some(t=>t.name===req.params?.name)) throw Error('Unknown tool')
      const res=await fetch(process.env.AGENT_FAMILY_URL, {method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${process.env.AGENT_FAMILY_TOKEN}`},body:JSON.stringify(req.params),signal:AbortSignal.timeout(120000)})
      const data=await res.json()
      respond({content:[{type:'text',text:JSON.stringify(data)}],isError:!res.ok})
    } else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32601,message:'Method not found'}})+'\n')
  } catch(e) {respond({content:[{type:'text',text:e.message}],isError:true})}
}
