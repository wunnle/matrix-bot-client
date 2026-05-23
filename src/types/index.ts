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
  image?: string
  fields?: { label: string; value: string }[]
  url?: string
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
  timestamp: number
  isOwnMessage: boolean
  isDecryptionFailure?: boolean
  isRead?: boolean
  reactions?: Record<string, string[]> // emoji → list of senderIds
}

export interface AuthState {
  accessToken: string
  userId: string
  deviceId: string
  homeserver: string
}
