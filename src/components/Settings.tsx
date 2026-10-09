import { useEffect, useMemo, useState } from 'react'
import * as sdk from 'matrix-js-sdk'
import type { AuthState } from '../types'
import { getCachedRooms, getClient, intentCredential, isInvite } from '../lib/matrix'
import { getDisabledShareRooms, setDisabledShareRooms, isShareableRoom } from '../lib/shareRooms'
import { donateShareTargets, getAppIcon, setAppIcon } from '../lib/liveActivity'
import { resolveMediaUrl } from '../lib/mediaUrl'
import { toggleDebug } from '../lib/debug'
import { apiUrl } from '../lib/apiUrl'

interface Props {
  auth: AuthState
  clientReady: boolean
  dictationAutoSend: boolean
  onDictationAutoSendChange: (value: boolean) => void
  onSignOut: () => void
}

// Each probe reports on its own: this runs in two very different environments
// (Safari/PWA and WKWebView, which has no Web Push and no Matrix client until
// sync), and one missing API used to throw away the whole report.
async function debugNotifications() {
  const line = async (label: string, probe: () => Promise<string>) => {
    try { return `${label}: ${await probe()}` } catch (e: any) { return `${label}: error — ${e?.message}` }
  }
  const report = [
    `Origin: ${location.origin}`,
    // Whether the offline shell is in place. In WKWebView a service worker only
    // runs on app-bound domains, so this is the quickest way to tell a native
    // build can cold-start offline.
    await line('Service worker', async () => {
      if (!('serviceWorker' in navigator)) return 'unsupported (no offline shell)'
      const reg = await navigator.serviceWorker.getRegistration()
      if (!reg) return 'not registered'
      const state = reg.active ? 'active' : reg.installing ? 'installing' : 'registered'
      return `${state} @ ${reg.scope}`
    }),
    await line('Shell cache', async () => {
      if (!('caches' in window)) return 'unsupported'
      const keys = await (await caches.open('construct-shell-v1')).keys()
      return keys.length ? `${keys.length} entries` : 'empty'
    }),
    // Absent in WKWebView — the native app is pushed via APNs.
    await line('Push subscription', async () => {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
      if (!reg?.pushManager) return 'n/a (native push)'
      const sub = await reg.pushManager.getSubscription()
      return sub?.endpoint ? `...${sub.endpoint.slice(-20)}` : 'none'
    }),
    // This feature works by making notifications *not* happen, so when it
    // misfires there's nothing to see. Listing who is holding the phone quiet
    // is the whole diagnosis.
    await line('Foreground clients', async () => {
      const secret = intentCredential()
      if (!secret) return 'n/a (not signed in)'
      const r = await fetch(apiUrl('/api/live-activity'), { headers: { 'x-intent-secret': secret } })
      const clients = (await r.json())?.activeClients ?? []
      if (!clients.length) return 'none — notifications flow normally'
      return '\n' + clients.map((c: { client: string; viewingRoom: string | null; ageMs: number }) =>
        `  ${c.client}${c.viewingRoom ? ` in ${c.viewingRoom.slice(0, 12)}…` : ''} (${Math.round(c.ageMs / 1000)}s ago)`
      ).join('\n')
    }),
    await line('Registered pushers', async () => {
      const pushers = await getClient().getPushers()
      return '\n' + ((pushers?.pushers ?? []).map((p: any) =>
        `  ${p.app_display_name} / ${p.device_display_name}: ...${String(p.pushkey).slice(-20)}`
      ).join('\n') || '  none')
    }),
  ]
  alert(report.join('\n'))
}

// The web app is served over the network (see capacitor.config.ts), so this
// picks up a deploy without reinstalling: the reload is a navigation, and the
// service worker fetches those network-first. Refresh the worker itself first —
// otherwise a changed sw.js is only noticed on the browser's own schedule,
// leaving the caching rules a deploy behind.
async function reloadApp() {
  try {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null
    await reg?.update()
  } catch { /* not fatal — reload anyway */ }
  window.location.reload()
}

/**
 * Settings tab: account, app toggles, and the share-sheet room picker. Share
 * selection is stored per-device; toggling re-donates the enabled set
 * immediately.
 */
// Alternate icons are built into the app (AppIcon-* in Assets.xcassets and
// ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES), so adding one needs a build.
const APP_ICONS: { name: string | null; label: string; preview: string }[] = [
  { name: null, label: 'Default', preview: '/app-icons/default.png' },
  { name: 'AppIcon-Bender', label: 'Bender', preview: '/app-icons/bender.png' },
]

export default function Settings({ auth, clientReady, dictationAutoSend, onDictationAutoSendChange, onSignOut }: Props) {
  // Pending invites can't be share targets — you haven't joined them yet.
  // Agent rooms are left out entirely rather than listed and switched off:
  // showing a toggle would promise a choice that isShareableRoom overrides.
  const rooms = useMemo(
    () => (getCachedRooms(auth.userId) ?? []).filter((r) => !isInvite(r) && isShareableRoom(r.roomId)),
    [auth.userId],
  )
  const [disabled, setDisabled] = useState<Set<string>>(() => getDisabledShareRooms(auth.userId))
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean | null>(null)
  // Null until known, and stays null where the icon can't be changed.
  const [appIcon, setAppIconState] = useState<{ name: string | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    void getAppIcon().then((icon) => { if (!cancelled) setAppIconState(icon) })
    return () => { cancelled = true }
  }, [])

  async function chooseAppIcon(name: string | null) {
    if (appIcon?.name === name) return
    try {
      await setAppIcon(name)
      setAppIconState({ name })
    } catch { /* iOS refused; the tick stays where it was */ }
  }

  // Own profile picture and the master push rule, once the client exists.
  useEffect(() => {
    if (!clientReady) return
    let cancelled = false
    let client: sdk.MatrixClient
    try { client = getClient() } catch { return }
    void (async () => {
      try {
        const info = (await client.getProfileInfo(auth.userId)) as { avatar_url?: string }
        const url = info?.avatar_url ? await resolveMediaUrl(client, info.avatar_url, 64, 64, 'crop') : null
        if (!cancelled) setAvatarUrl(url ?? null)
      } catch { /* initial stays */ }
    })()
    void (async () => {
      try {
        const rules = await client.getPushRules()
        if (cancelled) return
        const master = rules?.global?.override?.find((r: sdk.IPushRule) => r.rule_id === '.m.rule.master')
        setNotificationsEnabled(master ? !master.enabled : true)
      } catch { /* toggle stays disabled */ }
    })()
    return () => { cancelled = true }
  }, [auth.userId, clientReady])

  async function toggleNotifications() {
    try {
      const next = !notificationsEnabled
      await getClient().setPushRuleEnabled('global', sdk.PushRuleKind.Override, '.m.rule.master', !next)
      setNotificationsEnabled(next)
    } catch { /* leave as it was */ }
  }

  function toggleShare(roomId: string) {
    const next = new Set(disabled)
    if (next.has(roomId)) next.delete(roomId)
    else next.add(roomId)
    setDisabled(next)
    setDisabledShareRooms(auth.userId, next)
    void donateShareTargets(
      rooms.filter(r => !next.has(r.roomId)).map(r => ({ roomId: r.roomId, name: r.name, avatarMxc: r.avatarMxc })),
      [...next],
    )
  }

  const shortId = auth.userId.replace(/^@/, '').split(':')[0]

  return (
    <div className="settings-screen">
      <h1 className="settings-title">Settings</h1>

      <section className="settings-section settings-account">
        <div className="settings-account-avatar">
          {avatarUrl ? <img src={avatarUrl} alt="" /> : (shortId[0]?.toUpperCase() ?? '?')}
        </div>
        <div className="settings-account-text">
          <div className="settings-account-name">{shortId}</div>
          <div className="settings-account-id">{auth.userId}</div>
        </div>
      </section>

      <section className="settings-section">
        <label className="settings-row">
          <span className="settings-row-label">Auto-send when done talking</span>
          <input
            type="checkbox"
            className="settings-row-toggle"
            checked={dictationAutoSend}
            onChange={(e) => onDictationAutoSendChange(e.target.checked)}
          />
        </label>
        <label className="settings-row">
          <span className="settings-row-label">Notifications</span>
          <input
            type="checkbox"
            className="settings-row-toggle"
            checked={notificationsEnabled ?? false}
            disabled={notificationsEnabled === null}
            onChange={toggleNotifications}
          />
        </label>
      </section>

      {appIcon && (
        <section className="settings-section">
          <h2 className="settings-section-title">App icon</h2>
          <div className="app-icon-picker">
            {APP_ICONS.map((icon) => (
              <button
                key={icon.label}
                type="button"
                className={`app-icon-option${appIcon.name === icon.name ? ' app-icon-option--selected' : ''}`}
                onClick={() => void chooseAppIcon(icon.name)}
                aria-pressed={appIcon.name === icon.name}
              >
                <img src={icon.preview} alt="" />
                <span>{icon.label}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="settings-section">
        <h2 className="settings-section-title">Share sheet</h2>
        <p className="settings-section-hint">
          Rooms you enable here show up as direct-share targets in the iOS share sheet.
        </p>
        {rooms.length === 0 && <p className="settings-empty">No rooms yet.</p>}
        {rooms.map(room => (
          <label key={room.roomId} className="settings-row">
            <span className="settings-row-label">{room.name}</span>
            <input
              type="checkbox"
              className="settings-row-toggle"
              checked={!disabled.has(room.roomId)}
              onChange={() => toggleShare(room.roomId)}
              aria-label={`Share to ${room.name}`}
            />
          </label>
        ))}
      </section>

      <section className="settings-section">
        <button className="settings-action" onClick={() => void debugNotifications()}>Debug notifications</button>
        <button className="settings-action" onClick={() => void reloadApp()}>Reload app</button>
        <button className="settings-action settings-action--danger" onClick={onSignOut}>Sign out</button>
      </section>

      <p className="settings-version" onClick={toggleDebug}>Construct v{__CONSTRUCT_VERSION__}</p>
    </div>
  )
}
