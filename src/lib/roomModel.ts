import type { Message } from '../types'
import { parseActions } from './actions'

export function getRoomModel(roomId: string): string | null {
  return localStorage.getItem(`room-model:${roomId}`)
}

export function setRoomModel(roomId: string, model: string) {
  localStorage.setItem(`room-model:${roomId}`, model)
}

// A bot's model picker: the agent bot's answer to !model ("Model: …" +
// [[!model <id>]]) or Hermes' to !switch ("Pick model:" + [[/luna]]).
export function isModelPicker(m: Message): boolean {
  if (m.isOwnMessage) return false
  const { actions } = parseActions(m.body)
  if (!actions.length) return false
  if (/^\s*Model:/.test(m.body)) return actions.every((a) => /^!model\s+\S+$/.test(a))
  if (/^\s*Pick model:/i.test(m.body)) return actions.every((a) => /^\/\w+$/.test(a))
  return false
}

// The ask and the answer of a model picker, which the header's model menu
// stands in for. The pick and the bot's confirmation stay, as the record.
export function isModelPickerTraffic(m: Message): boolean {
  return (m.isOwnMessage && /^!(model|switch)$/.test(m.body.trim())) || isModelPicker(m)
}
