export interface Rankable { title: string; keywords?: string[]; recency?: number }
export function fold(s: string): string
export function matchTier(query: string, title: string, keywords?: string[]): number
export function textMatches(query: string, text: string): boolean
export function snippet(text: string, query: string, max?: number): string
export function rankCommands<T extends Rankable>(items: T[], query: string, limit?: number): T[]
