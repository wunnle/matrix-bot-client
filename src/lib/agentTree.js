// Parent-first display only. Never derive authorization from client room state.
// Each row also says how to draw the tree lines into it: whether it is the
// last of its siblings (where its parent's line turns into it), whether it has
// children (a line leaves its avatar), and agentTreeRails[L], whether the line
// of the ancestor at depth L passes straight through this row.
export function agentTree(rooms) {
  const ids = new Set(rooms.map(r => r.roomId))
  const seen = new Set(); const out = []
  const visit = (r, depth, rails, last) => {
    seen.add(r.roomId)
    const parentAgentName = rooms.find(p => p.roomId === r.parentAgentRoomId)?.name
    const children = rooms.filter(c => c.parentAgentRoomId === r.roomId && !seen.has(c.roomId))
    children.forEach(c => seen.add(c.roomId))
    out.push({...r, agentTreeDepth: depth, parentAgentName, agentTreeLast: last, agentTreeHasChildren: children.length > 0, agentTreeRails: rails})
    const childRails = depth > 0 ? [...rails, !last] : []
    children.forEach((c, i) => visit(c, depth + 1, childRails, i === children.length - 1))
  }
  for (const r of rooms) if (!seen.has(r.roomId) && (!r.parentAgentRoomId || !ids.has(r.parentAgentRoomId))) visit(r, 0, [], true)
  for (const r of rooms) if (!seen.has(r.roomId)) visit(r, 0, [], true)
  return out
}
