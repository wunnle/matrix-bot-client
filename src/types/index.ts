export interface RoomConfig {
  label?: string
  pills?: string[]
  suggestions?: string[]
}

export interface RoomsConfig {
  [roomId: string]: RoomConfig
}

export interface Message {
  eventId: string
  sender: string
  body: string
  formattedBody?: string
  imageUrl?: string
  timestamp: number
  isOwnMessage: boolean
  isDecryptionFailure?: boolean
}

export interface AuthState {
  accessToken: string
  userId: string
  deviceId: string
  homeserver: string
}
