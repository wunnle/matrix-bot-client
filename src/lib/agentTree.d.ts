export function agentTree<T extends {roomId:string;parentAgentRoomId?:string;name?:string}>(rooms:T[]):(T & {agentTreeDepth:number;parentAgentName?:string})[]
