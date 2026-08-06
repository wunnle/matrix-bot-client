// Provider registry. A room records which provider it uses; everything the bot
// does to run a turn goes through the object this hands back.
//
// A provider implements:
//   name           string, as stored in sessions.json
//   models         { alias: modelId } offered by !model
//   defaultModel   modelId used when a room names none
//   resolveModel(name) -> modelId | null    (alias or full id; null = not ours)
//   label(modelId) -> string                (short name, for display)
//   run({ roomId, prompt, cwd, model, sessionId, instructions, approval,
//         timeoutMs, onSession }) -> Promise<{ text, isError } | { error }>
//   cancel(roomId) -> boolean               (false when nothing was running)
import { claude } from './claude.mjs'
import { codex } from './codex.mjs'

export const PROVIDERS = { claude, codex }
export const DEFAULT_PROVIDER = 'claude'

// The provider a room is bound to. Sessions written before providers existed
// have no `provider` field, and they are all Claude rooms.
export function providerFor(session) {
  return PROVIDERS[session?.provider ?? DEFAULT_PROVIDER] ?? claude
}

// Finds the provider that owns a model name. This is what lets `!spawn <path>
// <model>` pick a backend without new syntax — the model name identifies it.
export function resolveModel(name) {
  if (!name) return null
  for (const provider of Object.values(PROVIDERS)) {
    const model = provider.resolveModel(name)
    if (model) return { provider: provider.name, model }
  }
  return null
}

// Every alias across every provider, for error messages and the !model pills.
export function allModelAliases() {
  return Object.values(PROVIDERS).flatMap((p) => Object.keys(p.models))
}
