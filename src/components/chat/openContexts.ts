import React from 'react'

// Opens an artifact in the room's side panel; provided by ChatView so the card,
// deep inside memoised message rows, needs no prop threaded down to it.
export const ArtifactOpenContext = React.createContext<((url: string) => void) | null>(null)

// Opens a page in the side panel's Browser tab; provided like the one above.
export const BrowserOpenContext = React.createContext<((url: string) => void) | null>(null)
