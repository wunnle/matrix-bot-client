// Parent-first display only. Never derive authorization from client room state.
export function agentTree(rooms) {
  const ids = new Set(rooms.map(r => r.roomId))
  const seen = new Set(); const out = []
  const visit = (r, depth) => {
    if(seen.has(r.roomId)) return
    seen.add(r.roomId); out.push({...r,agentTreeDepth:depth,parentAgentName:rooms.find(p=>p.roomId===r.parentAgentRoomId)?.name})
    for(const c of rooms) if(c.parentAgentRoomId===r.roomId) visit(c,depth+1)
  }
  for(const r of rooms) if(!r.parentAgentRoomId || !ids.has(r.parentAgentRoomId)) visit(r,0)
  for(const r of rooms) visit(r,0)
  return out
}
