import type { ReactNode } from 'react'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import type { Message } from '../types'
import type { RoomSummary } from '../lib/matrix'
import type { RoomAgentState } from '../lib/roomAgentState'
import { collectRoomMedia } from '../lib/roomMedia'
import { MessageRow, type MessageRowProps } from '../components/ChatView'
import ApprovalBar from '../components/ApprovalBar'
import { AgentActivityBar } from '../components/AgentActivityBar'
import RoomSidebar from '../components/RoomSidebar'
import { AgentRoomRow, InviteTile, SortableRoomCard, SpawnTile } from '../components/RoomList'
import { AVATAR_BG, CANDIDATES, SHADES, SPRITES, spriteSvg } from './sprites'
import './design.css'

/**
 * Construct's UI pieces in their states, rendered by the real components with
 * sample data: a design library at /design. No login, nothing links to it.
 */

const noop = () => {}
const svgUrl = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
const avatar = (name: keyof typeof SPRITES, shade: keyof typeof SHADES = 'crail') => svgUrl(spriteSvg(SPRITES[name], SHADES[shade]))

const NOW = Date.now()
const ME = '@sinan:matrix.org'
let seq = 0
const bot = (body: string, extra: Partial<Message> = {}): Message =>
  ({ eventId: `$demo${seq++}`, sender: '@bot:matrix.org', body, timestamp: NOW - 60_000, isOwnMessage: false, ...extra })
const own = (body: string): Message =>
  ({ eventId: `$demo${seq++}`, sender: ME, body, timestamp: NOW - 30_000, isOwnMessage: true, isRead: true })

const rowDefaults: Omit<MessageRowProps, 'msg'> = {
  userId: ME,
  showDateDivider: false,
  senderSwitch: true,
  showPeerSender: false,
  isTool: false,
  prevIsTool: false,
  nextIsTool: false,
  canPin: false,
  toolSummary: '',
  toolLive: false,
  isPinned: false,
  pinInFlight: false,
  selecting: false,
  liveRun: null,
  botTyping: false,
  onLiveChange: noop,
  onOpenToolDialog: noop,
  onOpenLightbox: noop,
  onOpenApproval: noop,
  onSubmitForm: noop,
  onPickChoice: noop,
  onRichClick: noop,
  onRichPointerDown: noop,
  onReact: noop,
  onCopy: noop,
  onTogglePin: noop,
  onInspect: noop,
}
const Row = (props: Partial<MessageRowProps> & { msg: Message }) => <MessageRow {...rowDefaults} {...props} />

const CHOICES = '\n\n[[Plan the wake word training (BEN-263)]] [[Prep a checklist for the uhubctl udev setup]] [[Check what is left on the Live Activity branch]]'
const FORM = { question: 'What should the sidebar collect?', options: [{ label: 'Links', description: 'URLs from messages, grouped by site' }, { label: 'Images' }, { label: 'Files' }, { label: 'Places' }] }

const MESSAGES = {
  plain: bot('Deployed: 1.0.440 is live. Hard-reload Construct to pick it up.'),
  rich: bot('rich', {
    formattedBody: '<h3>What changed</h3><ul><li><strong>Agent rows</strong> under the tiles</li><li>Wider sidebar from <code>1100px</code></li></ul><pre><code>vercel-wait\nREADY 2c4cb6b (site serves 1.0.440)</code></pre><table><thead><tr><th>Check</th><th>Result</th></tr></thead><tbody><tr><td>tsc</td><td>passes</td></tr><tr><td>lint</td><td>no new errors</td></tr></tbody></table>',
  }),
  ownMsg: own('Commit and deploy'),
  choicesOpen: bot(`Which should I build next?${CHOICES}`),
  choicesPicked: bot(`Which should I build next?${CHOICES}`),
  choicesFaded: bot(`Which should I build next?${CHOICES}`),
  formOpen: bot('Pick what applies.', { form: FORM }),
  formDone: bot('Pick what applies.', { form: FORM }),
  card: bot('Here is the deploy.', {
    cards: [{ title: 'matrix-bot-client', subtitle: 'Production · 1.0.440', description: 'Built in 41s from 2c4cb6b.', fields: [{ label: 'Status', value: 'Ready' }, { label: 'Region', value: 'fra1' }], url: 'https://construct.kafagoz.com' }],
  }),
  place: bot('📍 Kronotrop Levent', { location: { lat: 41.08012, lon: 29.01145, description: 'Kronotrop Levent' } }),
  tool: bot('🔧 Bash: npm run build', { toolProgress: [{ emoji: '🔧', tool: 'Bash', content: 'npm run build' }] }),
  dated: bot('Good morning. Three things on the calendar today.', { timestamp: NOW - 86_400_000 }),
  reacted: { ...own('Ship it'), reactions: { '👍': ['@bot:matrix.org'], '🚀': ['@bot:matrix.org', ME] } },
  peer: bot('Can you add the Kadıköy one too?', { isPeerMessage: true, senderName: 'Deniz' }),
  machine: bot('📝 Note saved: Daily Notes/2026-10-20', { machine: { kind: 'notification', source: 'note-watcher' } }),
  failed: bot('🔒 Unable to decrypt', { isDecryptionFailure: true }),
  cards: bot('Two options under 3,000 TL.', {
    cards: [
      {
        title: 'Keychron K2 Pro',
        subtitle: 'Hepsiburada · in stock',
        description: 'Wireless, hot-swappable, brown switches.',
        image: svgUrl(spriteSvg(SPRITES.rocket, '#2a2a38', '#9ab')),
        price: '2,849 TL',
        actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'Compare', url: 'https://example.com' }],
      },
      { title: 'Construct deploys', subtitle: 'vercel.com', description: 'A plain link card: the whole card is the link.', url: 'https://vercel.com' },
    ],
  }),
  artifact: bot('📄 Claude Code Integration: https://claude.ai/artifact/CPN1WCF3uQZ1Qu7viFLkQ9', {
    machine: { kind: 'notification', source: 'claude-artifact' },
    artifact: { url: 'https://claude.ai/artifact/CPN1WCF3uQZ1Qu7viFLkQ9', title: 'Claude Code Integration', description: 'Status of the project bringing subagents and artifacts into agent rooms.', version: 2 },
  }),
  subagent: bot('🤖 agent: Survey room list rendering (Explore) — working', {
    machine: { kind: 'notification', source: 'claude-subagent' },
    subagent: { id: 't1', description: 'Survey room list rendering', agentType: 'Explore', status: 'running', lines: [{ emoji: '📖', tool: 'read', content: 'src/components/RoomList.tsx' }], toolUses: 7, durationMs: 42000 },
  }),
  threads: bot('threads', {
    threads: [
      { title: 'Why the build failed', summary: 'A type error in RoomList.tsx after the merge.', body: 'The merge kept both `agent` fields.\n\n```\nsrc/components/RoomList.tsx:88 TS2300 Duplicate identifier\n```\n\nFixed by dropping the older one.' },
      { title: 'What changed in the bot', summary: 'Avatar cast, per-room pick.', body: '- Five characters\n- Picked from the room id\n- Never replaces an avatar you set' },
    ],
  }),
}

const SHARED = collectRoomMedia([
  bot('📄 Claude Code Integration: https://claude.ai/artifact/CPN1WCF3uQZ1Qu7viFLkQ9', {
    eventId: '$art1',
    artifact: { url: 'https://claude.ai/artifact/CPN1WCF3uQZ1Qu7viFLkQ9', title: 'Claude Code Integration', description: 'Status of the project bringing subagents and artifacts into agent rooms.', version: 2 },
  }),
  bot('Draft is at https://claude.ai/artifact/Q3PlanDraft01', { formattedBody: 'Draft is at <a href="https://claude.ai/artifact/Q3PlanDraft01">Q3 plan</a>' }),
  bot('See https://interestingengineering.com/ai-robotics/xai-grok-bot-computer-agent and BEN-263.', {
    formattedBody: '<a href="https://interestingengineering.com/ai-robotics/xai-grok-bot-computer-agent">Grok Bot is xAI\'s new 24/7 coworker</a> and BEN-263.',
  }),
  bot('PR is up: https://github.com/wunnle/matrix-pwa/pull/42', { formattedBody: '<a href="https://github.com/wunnle/matrix-pwa/pull/42">Lettered lists</a>' }),
  bot('Review: https://www.layer3labs.io/guides/grok-bot-review', { formattedBody: '<a href="https://www.layer3labs.io/guides/grok-bot-review">Layer3 Labs review</a>' }),
  { ...bot('rocket.png'), imageMxc: 'mxc://demo/1', eventId: '$img1' },
  { ...bot('squid.png'), imageMxc: 'mxc://demo/2', eventId: '$img2' },
  { ...bot('report.pdf'), fileMxc: 'mxc://demo/3', fileName: 'grok-bot-notes.pdf', eventId: '$file1' },
  MESSAGES.place,
  bot('Saved to obsidian://open?vault=Obsidian&file=Bender%2FFunctionalities%2FGH%20Wrapper'),
  bot('This builds on [[Bender/Functionalities/Hermes Gateway]] and [[Daily Notes/2026-10-20|today]].'),
])
const SHARED_URLS = { $img1: avatar('rocket'), $img2: avatar('squid'), $file1: '#' }

const room = (name: string, extra: Partial<RoomSummary> = {}): RoomSummary =>
  ({ roomId: `!${name}`, name, unreadCount: 0, membership: 'join', ...extra })
const TILES = [room('Hermes'), room('Spotify', { unreadCount: 2 }), room('Day'), room('Watchlist')]
const AGENTS: { room: RoomSummary; avatar: string; agent?: RoomAgentState; active?: boolean }[] = [
  { room: room('Discord Digest', { lastMessage: 'Approve: git push origin main' }), avatar: avatar('invader', 'brick'), agent: { kind: 'approval' } },
  { room: room('Grok Bot Lessons', { lastMessage: 'Agreed. For agent rooms the avatar is just…' }), avatar: avatar('saucer', 'amber'), active: true },
  { room: room('Push Room Names', { lastMessage: 'The change is live: Vercel shows commit 9f2…', unreadCount: 1 }), avatar: avatar('rocket') },
  { room: room('Jev Exploration', { lastMessage: 'Looking at the fast commands' }), avatar: avatar('crown', 'amber'), agent: { kind: 'working', label: 'Bash' } },
  { room: room('Voice PE Bender', { lastMessage: 'Which wake word model?' }), avatar: avatar('squid', 'brick'), agent: { kind: 'question' } },
  { room: room('Usage Limit', { lastMessage: 'Paused until 14:00' }), avatar: avatar('rocket', 'brick'), agent: { kind: 'blocked' } },
  { room: room('Jev Experiments'), avatar: avatar('invader') },
]

function Section({ title, note, children, wide }: { title: string; note?: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`dl-section${wide ? ' dl-section--wide' : ''}`}>
      <h2>{title}</h2>
      {note && <p className="dl-note">{note}</p>}
      {children}
    </section>
  )
}

function Frame({ label, children, className = '' }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <div className="dl-frame-wrap">
      {label && <div className="dl-label">{label}</div>}
      <div className={`dl-frame ${className}`}>{children}</div>
    </div>
  )
}

// A character at 72px, then at 36px on each tile it comes in.
function Sprite({ name, grid, shades }: { name: string; grid: string[]; shades: string[] }) {
  return (
    <figure className="dl-sprite">
      <img src={svgUrl(spriteSvg(grid, shades[0]))} alt="" width={72} height={72} />
      <div className="dl-sprite-shades">
        {shades.map((c) => <img key={c} src={svgUrl(spriteSvg(grid, c))} alt="" width={36} height={36} />)}
      </div>
      <figcaption>{name}</figcaption>
    </figure>
  )
}

export default function DesignLibrary() {
  return (
    <div className="dl">
      <header className="dl-header">
        <h1>Construct design library</h1>
        <p>The real components with sample data. Dark theme, as in the app.</p>
      </header>

      <Section title="Agent avatars" note="Each Claude room gets one character on one shade, picked from its room id. Then candidates, on the original orange." wide>
        <div className="dl-label">In use · {Object.keys(SHADES).join(', ')}</div>
        <div className="dl-sprites">
          {Object.entries(SPRITES).map(([n, g]) => <Sprite key={n} name={n} grid={g} shades={Object.values(SHADES)} />)}
        </div>
        <div className="dl-label">Candidates</div>
        <div className="dl-sprites">
          {Object.entries(CANDIDATES).map(([n, g]) => <Sprite key={n} name={n} grid={g} shades={[AVATAR_BG]} />)}
        </div>
      </Section>

      <Section title="Room list" note="Tiles for Hermes rooms, rows for agent rooms. Badges: approval, working, question, usage limit, unread.">
        <Frame className="dl-roomlist">
          <DndContext>
            <SortableContext items={TILES.map((r) => r.roomId)}>
              <div className="room-grid">
                {TILES.map((r) => (
                  <SortableRoomCard key={r.roomId} room={r} isActive={false} hasNotification={false} onSelect={noop} />
                ))}
                <InviteTile room={room('Invite')} busy={false} onAccept={noop} />
              </div>
            </SortableContext>
          </DndContext>
          <section className="room-rows">
            <h2 className="room-rows-title">Agents</h2>
            {AGENTS.map((a) => (
              <AgentRoomRow key={a.room.roomId} room={a.room} isActive={!!a.active} avatar={a.avatar} hasNotification={false} agent={a.agent} onSelect={noop} />
            ))}
            <SpawnTile provider="claude" busy={false} disabled={false} onSpawn={noop} />
            <SpawnTile provider="codex" busy={false} disabled={false} onSpawn={noop} />
          </section>
        </Frame>
      </Section>

      <Section title="Messages" note="Bot text, rich text, your message, a card, a place and the tool chip.">
        <Frame className="dl-chat">
          <div className="messages-inner">
            <Row msg={MESSAGES.plain} />
            <Row msg={MESSAGES.rich} />
            <Row msg={MESSAGES.ownMsg} />
            <Row msg={MESSAGES.card} />
            <Row msg={MESSAGES.place} />
            <Row msg={MESSAGES.tool} isTool toolSummary="Bash ×3 · Edit ×2" />
          </div>
        </Frame>
      </Section>

      <Section title="Agent cards" note="A subagent at work, and a page an agent published to claude.ai.">
        <Frame className="dl-chat">
          <div className="messages-inner">
            <Row msg={MESSAGES.subagent} />
            <Row msg={MESSAGES.artifact} />
          </div>
        </Frame>
      </Section>

      <Section title="More messages" note="Date divider, reactions, someone else in the room, a machine notification, a message that would not decrypt.">
        <Frame className="dl-chat">
          <div className="messages-inner">
            <Row msg={MESSAGES.dated} showDateDivider />
            <Row msg={MESSAGES.reacted} />
            <Row msg={MESSAGES.peer} showPeerSender />
            <Row msg={MESSAGES.machine} />
            <Row msg={MESSAGES.failed} />
          </div>
        </Frame>
      </Section>

      <Section title="Cards" note="com.construct.cards: with image, price and actions; a plain link card.">
        <Frame className="dl-chat"><div className="messages-inner"><Row msg={MESSAGES.cards} /></div></Frame>
      </Section>

      <Section title="Accordion" note="com.construct.threads: a title and summary that open into the full text.">
        <Frame className="dl-chat"><div className="messages-inner"><Row msg={MESSAGES.threads} /></div></Frame>
      </Section>

      <Section title="Agent activity" note="Above the composer while a run is on: thinking, then the tool in flight.">
        <Frame className="dl-footer">
          <AgentActivityBar run={{ phase: 'thinking', label: 'Thinking', startedAt: NOW - 4_000, lastSignalAt: NOW }} botTyping onLiveChange={noop} />
        </Frame>
        <Frame className="dl-footer">
          <AgentActivityBar run={{ phase: 'working', label: 'Running', detail: 'npm run build', startedAt: NOW - 73_000, lastSignalAt: NOW }} botTyping={false} onLiveChange={noop} />
        </Frame>
      </Section>

      <Section title="Answer lists" note="[[…]] options: open; answered (collapses to the pick); passed by (fades). Letter keys pick when the composer is not focused.">
        <Frame label="Open" className="dl-chat"><div className="messages-inner"><Row msg={MESSAGES.choicesOpen} choiceOpen /></div></Frame>
        <Frame label="Answered" className="dl-chat"><div className="messages-inner"><Row msg={MESSAGES.choicesPicked} choiceOpen={false} choicePicked="Prep a checklist for the uhubctl udev setup" /></div></Frame>
        <Frame label="Unanswered, room moved on" className="dl-chat"><div className="messages-inner"><Row msg={MESSAGES.choicesFaded} choiceOpen={false} /></div></Frame>
      </Section>

      <Section title="Forms" note="```form blocks: pick any, then Submit. Same rows as the answer lists.">
        <Frame label="Open" className="dl-chat"><div className="messages-inner"><Row msg={MESSAGES.formOpen} /></div></Frame>
        <Frame label="Answered" className="dl-chat"><div className="messages-inner"><Row msg={MESSAGES.formDone} formAnswer={'Links\nPlaces'} /></div></Frame>
      </Section>

      <Section title="Approval bar" note="Stands in for the pills while an agent waits on a tool approval.">
        <Frame className="dl-footer">
          <ApprovalBar
            card={{ tool: 'Bash', target: 'git push origin main', reason: 'Pushes to the shared main branch' }}
            approve="Approve"
            deny="Deny"
            always="Always allow"
            auto="Approve + auto"
            onAnswer={noop}
            onView={noop}
          />
        </Frame>
      </Section>

      <Section title="Pills" note="Saved replies above the composer; bot commands like !model stay pills.">
        <Frame className="dl-footer">
          <div className="pills">
            <button className="pill pill-action">Opus 5.5</button>
            <button className="pill">!stop</button>
            <button className="pill">!continue</button>
            <button className="pill">deploy</button>
            <button className="pill pill-add">+</button>
          </div>
        </Frame>
      </Section>

      <Section title="Shared panel" note="Links, images, files, places, Linear issues and PRs from the loaded messages.">
        <Frame className="dl-shared">
          <RoomSidebar
            media={SHARED}
            mediaUrls={SHARED_URLS}
            hasMore
            loadingMore={false}
            onLoadMore={noop}
            onJump={noop}
            onOpenImage={noop}
            onClose={noop}
            tab="shared"
            onTab={noop}
            openArtifact={null}
            onOpenArtifact={noop}
          />
        </Frame>
      </Section>

      <Section title="Artifacts panel" note="Pages agents published to claude.ai: the list, and one opened (here without an in-app copy).">
        <Frame className="dl-shared">
          <RoomSidebar
            media={SHARED}
            mediaUrls={SHARED_URLS}
            hasMore={false}
            loadingMore={false}
            onLoadMore={noop}
            onJump={noop}
            onOpenImage={noop}
            onClose={noop}
            tab="artifacts"
            onTab={noop}
            openArtifact={null}
            onOpenArtifact={noop}
          />
        </Frame>
        <Frame className="dl-shared">
          <RoomSidebar
            media={SHARED}
            mediaUrls={SHARED_URLS}
            hasMore={false}
            loadingMore={false}
            onLoadMore={noop}
            onJump={noop}
            onOpenImage={noop}
            onClose={noop}
            tab="artifacts"
            onTab={noop}
            openArtifact={undefined}
            onOpenArtifact={noop}
          />
        </Frame>
      </Section>
    </div>
  )
}
