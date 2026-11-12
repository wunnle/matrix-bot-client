import { useEffect, useState } from 'react'
import * as sdk from 'matrix-js-sdk'

/** Who else in the room is typing, by the localpart of their user id. */
export function useTypingUsers(client: sdk.MatrixClient, roomId: string, userId: string): string[] {
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  useEffect(() => {
    const onTyping = (_event: sdk.MatrixEvent, member: sdk.RoomMember) => {
      if (member.roomId !== roomId) return
      const room = client.getRoom(roomId)
      if (!room) return
      const typing = room.getMembersWithMembership('join')
        .filter((m) => m.typing && m.userId !== userId)
        // Display names: a room with several agents says which one is thinking.
        .map((m) => m.name || m.userId.replace(/^@/, '').split(':')[0])
      setTypingUsers(typing)
    }
    client.on(sdk.RoomMemberEvent.Typing, onTyping)
    return () => { client.off(sdk.RoomMemberEvent.Typing, onTyping) }
  }, [roomId, userId, client])
  return typingUsers
}
