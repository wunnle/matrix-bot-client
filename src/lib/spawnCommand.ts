export type AgentProvider = 'claude' | 'codex'

const CODEX_DEFAULT_MODEL = 'gpt-5.6-sol'

export function spawnCommand(provider: AgentProvider): string {
  if (provider === 'claude') return '!spawn'
  if (provider === 'codex') return `!spawn ${CODEX_DEFAULT_MODEL}`
  throw new Error(`Unknown agent provider: ${provider}`)
}

export function createSpawnGate() {
  let active = false
  return {
    begin() {
      if (active) return false
      active = true
      return true
    },
    end() { active = false },
  }
}
