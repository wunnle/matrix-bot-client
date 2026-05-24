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
}

export interface AuthState {
  accessToken: string
  userId: string
  deviceId: string
  homeserver: string
}
