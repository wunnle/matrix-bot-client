export interface RoomConfig {
  label?: string
  pills?: string[]
  suggestions?: string[]
}

export interface RoomsConfig {
  [roomId: string]: RoomConfig
}

export interface ConstructCard {
  title: string
  subtitle?: string
  description?: string
  image?: string
  fields?: { label: string; value: string }[]
  price?: string
  url?: string
  actions?: { label: string; url: string }[]
}

export interface ConstructThread {
  title: string
  summary?: string
  body: string
}

export interface ToolProgressLine {
  emoji: string
  tool: string
  content?: string
  repeat?: number
  raw?: string
}

export interface Message {
  eventId: string
  sender: string
  body: string
  formattedBody?: string
  imageUrl?: string
  imageMxc?: string
  fileMxc?: string
  fileName?: string
  fileMime?: string
  cards?: ConstructCard[]
  threads?: ConstructThread[]
  toolProgress?: ToolProgressLine[]
  timestamp: number
  isOwnMessage: boolean
  isDecryptionFailure?: boolean
  isRead?: boolean
  reactions?: Record<string, string[]> // emoji → list of senderIds
  source?: string // com.construct.source — e.g. "voice"
  machine?: MachineMarker // com.construct.machine — posted by a bot, not a human
}

// Marks a message as machine-generated: a notification or orchestration event
// nobody typed. Agents use it to know the run was not user-initiated (see the
// construct-matrix adapter); the UI uses it to render such messages quietly so
// they don't read as someone talking to you.
export interface MachineMarker {
  kind?: string // "notification" | "task" | "result" | …
  source?: string // which component emitted it, e.g. "note-watcher"
}

export interface AuthState {
  accessToken: string
  userId: string
  deviceId: string
  homeserver: string
}
