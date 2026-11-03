import { useMemo } from 'react'
import type { Message } from '../types'
import { isChoiceList, parseActions, pickedChoice } from '../lib/actions'
import { approvalChoices, parseApprovalCard } from '../lib/approval'
import { isBotToolProgress } from '../lib/toolProgress'
import { isModelPicker } from '../lib/roomModel'

/** What the newest bot message asks of you: its [[…]] answers, and which of
 *  the approval bar, the model menu, a lettered list or the pill row shows them. */
export function useMessageActions(messages: Message[]) {
  // Action pills reflect the last message only: once you reply (or the bot
  // says anything after), the previous message's [[buttons]] should clear.
  // Tool lines and mid-turn narration don't count as "saying anything" — the
  // bot keeps posting those while an approval card waits on you, and letting
  // them win took the Approve / Deny pills away the moment one landed.
  const lastActionMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      // A subagent card is progress too; one posted behind an approval card
      // must not take its approval bar away.
      if (isBotToolProgress(m) || ((m.interim || m.subagent || m.artifact || m.browser) && !m.isOwnMessage && !m.isPeerMessage)) continue
      return m.isOwnMessage ? null : m
    }
    return null
  }, [messages])
  const lastActions = useMemo(
    () => (lastActionMessage ? parseActions(lastActionMessage.body).actions : []),
    [lastActionMessage],
  )
  // That message, when it is an approval card: it gets the approval bar in
  // place of the pill row.
  const pendingApproval = useMemo(() => {
    if (!lastActionMessage) return null
    const { approve, deny, always, session, auto } = approvalChoices(lastActions)
    const card = approve ? parseApprovalCard(lastActionMessage.body) : null
    if (!approve || !card) return null
    return { msg: lastActionMessage, card, approve, deny, always, session, auto }
  }, [lastActionMessage, lastActions])
  // That message, when it is a model picker — the agent bot's answer to !model
  // ("Model: …" + [[!model <id>]]) or Hermes' to !switch ("Pick model:" +
  // [[/luna]]): the model menu lists its options, and the timeline hides it.
  const modelPicker = useMemo(
    () => (lastActionMessage && isModelPicker(lastActionMessage) ? { msg: lastActionMessage, options: lastActions } : null),
    [lastActionMessage, lastActions],
  )
  // A bot message's [[…]] answers show as a lettered list under its text, not
  // as pills: open on the last message, faded on older ones,
  // with the option your next message picked kept lit. That message itself
  // leaves the timeline: the lit option already says what you sent.
  const { choiceLists, choiceReplies } = useMemo(() => {
    const lists: Record<string, { open: boolean; picked?: string }> = {}
    const replies = new Set<string>()
    // Walking back, the nearest own message after the one being looked at.
    let reply: Message | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.isOwnMessage) { reply = m; continue }
      if (!m.body.includes('[[')) continue
      const { actions } = parseActions(m.body)
      if (!isChoiceList(actions)) continue
      // Approval cards answer through the approval bar.
      if (approvalChoices(actions).approve && parseApprovalCard(m.body)) continue
      const picked = m !== lastActionMessage && reply ? pickedChoice(reply.body, actions) : undefined
      if (picked) replies.add(reply!.eventId)
      lists[m.eventId] = { open: m === lastActionMessage, picked }
    }
    return { choiceLists: lists, choiceReplies: replies }
  }, [messages, lastActionMessage])
  const openChoices = lastActionMessage && choiceLists[lastActionMessage.eventId] ? lastActions : null
  // The reply buttons the pill row shows: none when the model menu or the
  // lettered list stands in for them.
  const pillActions = modelPicker || openChoices ? [] : lastActions

  return { lastActionMessage, pendingApproval, modelPicker, choiceLists, choiceReplies, openChoices, pillActions }
}
