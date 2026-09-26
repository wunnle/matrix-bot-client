# Handoff: multi-activity Live Activities (native side)

Branch: `mac/ben-285-multi-activity`. Not merged; merge together with the server
side once both are tested.

## Done

- **Attributes** (`ConstructActivityAttributes`, identical copies in
  `AppDelegate.swift` and `ContructWidgetsLiveActivity.swift`): `{ activityId }`
  plus the ContentState from the contract (title, body, tone, progress, step,
  actions `[{label, send}]`, roomId, roomName, endsAt as unix seconds).
- **Lenient decoding.** Swift's synthesized `Decodable` ignores property
  defaults and throws on any missing key, which ActivityKit turns into a
  silently dropped push. Both copies now have a hand-written `init(from:)` that
  falls back to the default for every missing field (tone → "neutral", strings
  → "", optionals → nil, actions → []). So the server may send partial
  content-state. Wrong *types* (e.g. `progress: "0.5"`) still fail the decode.
- **Tokens keyed by activityId.** Every activity (started locally, by push, or
  already running when the app launches) registers `{ activityId, token }` and
  re-posts on token rotation. On `.ended`/`.dismissed` the app posts
  `{ action: "end", activityId }` and then a reconcile.
- **Reconcile** runs on every app foreground and after any activity ends (see the
  amendment below). The old GET-and-clear-per-room path and `intentGet` are gone.
- **Push-to-start token** registration unchanged.
- **Button taps**: `QuickReplyIntent` now carries `activityId`, posts
  `{ room, text: action.send, source: "live-activity", activityId }` to
  `/api/send-message`. Empty roomId falls back to the default room, as before.
- **"Thinking…" removed**: `markActivitySending`, `runAskWatch`,
  `awaitLiveActivityToken`, the global `"*"` token key. Ask Construct and Send
  Screenshot still post their message and no longer touch Live Activities (they
  also dropped `LiveActivityIntent`). `WatchConstructReplyIntent` is kept as a
  no-op so shortcuts that still end with it don't fail on a missing action.
- **Widget redesign**: room avatar, roomName (small), title, body, optional
  progress bar and step label, endsAt as a live countdown (timer Text, ticks
  without pushes), up to 3 buttons. Tone tints the accent: neutral purple,
  success green, warning amber, error red. Compact island: avatar left;
  right shows countdown, else step, else progress ring, else a glyph. Dark
  background and existing island insets kept.
- **Plugin** (debug overlay only): `start({activityId?, ...state})` (no id →
  UUID; an id already on screen gets updated instead), `update({activityId,
  ...fields})` merges into current state, `end({activityId?})` (no id → all).
  The overlay has two test activities, `debug-A` and `debug-B`.

## Contract amendment: reconcile

```
POST /api/live-activity   (x-intent-secret header)
{ "action": "reconcile", "activityIds": ["<id>", ...] }
```

`activityIds` = every activity whose state is `.active` or `.stale`. The server
drops every update token whose activityId isn't listed; an empty list clears
all. Expected response `{ "ok": true, "removed": <count> }` (the app ignores it).

## Contract deviations

None.

## Notes for the server

- Until the new `api/live-activity` is deployed, `{ activityId, token }`,
  `end` by activityId and `reconcile` all get rejected by the current
  room-keyed handler. Push-to-start still works. Deploy before remote testing.
- This is a development-signed build: its tokens are sandbox APNs.
- The debug overlay changes are web code: the installed app loads
  construct.kafagoz.com, so the overlay's new buttons appear only after the
  branch merges and deploys. Before that, the plugin can be driven from Safari
  Web Inspector: `Capacitor.Plugins.LiveActivity.start({ activityId: 'x', title: 'Hi' })`.

## Tested

- Builds cleanly (Release archive, all five targets, development signing, App
  Group on all of them). Installed and launched on Sinan's iPhone from commit
  93255ed.
- Not yet on device: two local activities side by side, button tap → message,
  notification reply without a Thinking activity, Shortcuts still posting.
  Those need Sinan at the phone (or the web inspector route above).
- Remote start/update/end from the Pi: pending the server deploy.

## Open problems

- Layout was checked in code only. Check the tallest case (warning + countdown
  + progress + 3 buttons) on a real lock screen; the #Preview canvases have that
  state (`approval`).
