export interface Rankable { title: string; keywords?: string[]; recency?: number }
export function matchTier(query: string, title: string, keywords?: string[]): number
export function rankCommands<T extends Rankable>(items: T[], query: string, limit?: number): T[]
