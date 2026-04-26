const ALIASES: Record<string, string> = {
  /**
   * Short path for the primary bot room, e.g. /rooms/default
   * (same as …/!DpRWqhWOHJAxyvjOGI%3Amatrix.org)
   */
  default: '!DpRWqhWOHJAxyvjOGI:matrix.org',
}

/**
 * Map a path segment (e.g. `default`) to a full Matrix room id, or return the
 * original string if it is not a known alias.
 */
export function resolveRoomIdFromParam(param: string): string {
  return ALIASES[param] ?? param
}
