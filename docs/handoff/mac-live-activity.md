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

- The deployed `api/live-activity` accepts the new calls: token, reconcile and
  push-to-start all answered 200 in the stale-credential test below.
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
- Remote start/update/end from the Pi: done in end-to-end testing; it found the
  stale-credential bug below.
- Layout on the iOS 26 simulator (lock screen stack and expanded island), via
  the debug demo. Type scale and timer placement adjusted with Sinan.
- Scene lifecycle fix: Release build launches on iOS 27 with no crash report.
  Relaunch after force-quit, notification-tap deep links and `construct://`
  links still to confirm on the phone.
- Stale-credential retry: see below.

## Fix: token registration with a stale credential

On a cold launch, activation registered tokens with whatever credential was
stored at that moment; the web layer stores the signed-in Matrix token
(`saveIntentConfig`) a moment later. After a reinstall the stored value was the
old rotated secret, the server answered 403, and nothing retried: the activity
was marked handled on the first attempt and the token streams only yield again
on rotation. Push-to-start had the same problem.

Now:
- Observing an activity's token/state streams (once per activity) is separate
  from registering its token. An activity counts as registered only when the
  POST returns 2xx, keyed by activityId and token.
- Every activation re-posts any live activity's current token that isn't
  registered. The current token is read from ActivityKit's own
  `activity.pushToken` rather than a copy we keep: it is the same value, kept
  current by the system.
- Every activation re-posts the push-to-start token (the last one the stream
  yielded, else `Activity.pushToStartToken`).
- `saveIntentConfig`: if the credential changed, forget what was registered and
  re-run reconcile, adoption and the push-to-start post immediately.

Tested on Sinan's iPhone with a Debug build launched with `-JunkIntentSecret
-LiveActivityDemo` (debug-only flags: store "junk" as the credential at launch;
start the three demo activities with push tokens). Console, in order: reconcile,
push-to-start and demo-0 token → 403; then, once the web layer stored the real
credential, demo-0/1/2 tokens, reconcile and push-to-start → 200. No relaunch.
Debug builds log each live-activity POST's action, activityId and status (never
the token or credential).

Unrelated, seen in the same console: one "JS Eval error" while the page is
still loading. Not investigated; not known whether it predates this branch.

## Also on this branch: scene lifecycle (not Live Activity work)

Builds from Xcode 27 (iOS 27 SDK) trapped at launch on iOS 27 in
`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption`: the SDK now
requires the UIScene lifecycle. Added `UIApplicationSceneManifest` to
`Info.plist` and a `SceneDelegate` (in AppDelegate.swift). Activation work moved
from `applicationDidBecomeActive` to `sceneDidBecomeActive`; URL opens and user
activities are forwarded to Capacitor's `ApplicationDelegateProxy` from the
scene callbacks, including the cold-launch ones in `willConnectTo`. Any native
build made with Xcode 27 needs this, so main needs it too.

## Debug demo

Debug builds launched with `-LiveActivityDemo` start three sample activities
(neutral/step+progress, success/3 buttons, warning/countdown+2 buttons) and
later re-post each with an alert, which pops the expanded Dynamic Island. It
only replaces earlier `demo-*` activities. Simulator:
`xcrun simctl launch <device> com.wunnle.construct -LiveActivityDemo`; device:
`xcrun devicectl device process launch --console --device <udid> com.wunnle.construct -- -LiveActivityDemo`.

## Open problems

- Expanded island: the room name is truncated in the narrow top-left region
  ("agent: cle…"). Proposed: move it into the bottom region beside the timer.
  Waiting on Sinan.

## Background sync for push-started activities

Branch: `mac/la-background-sync`. Not merged.

Problem: a push-started activity registers its update token only when the app
runs. With the app terminated (overnight), nothing ran, the server could never
update or end the card, and it sat on the lock screen for hours. Info.plist only
declared `audio`, so iOS had no reason to wake the app.

### What changed

- **Info.plist:** `UIBackgroundModes` is now `audio` + `remote-notification`.
  Construct now appears under Settings → General → Background App Refresh,
  which must be on.
- **Silent "la-sync" push** (`AppDelegate.application(_:didReceiveRemoteNotification:fetchCompletionHandler:)`):
  when `userInfo["construct"] == "la-sync"` it runs the full sync (below), posts
  every live activity's `pushToken` straight away instead of waiting for
  `pushTokenUpdates`, then waits until every live activity has *posted* a token
  (answered, accepted or not) or 20 s pass. Then `.newData`, or `.noData` if
  there was no live activity. Anything else gets `.noData` and nothing more.
  Capacitor's push plugin never implemented this method: it sees message
  notifications through the `UNUserNotificationCenter` delegate, which is
  untouched, and message pushes carry `mutable-content`, not
  `content-available`, so they never reach this method. The service/content
  extensions and Reply are unaffected.
- **Sync** (`syncLiveActivityRegistrations`, on activation, la-sync, and a
  credential change) now runs in order: end expired cards → reconcile, adopt
  running activities, post current tokens, re-post push-to-start
  (concurrently). It returns a Task the la-sync path awaits.
- **Backstop:** every sync ends (`.end(nil, dismissalPolicy: .immediate)`) any
  live activity whose `content.staleDate` is more than 10 minutes past. It runs
  before reconcile, so the same sync also drops its server token.
- **Registry:** in-flight posts are deduplicated (the stream's first yield and
  the direct post of `activity.pushToken` can race), and the registry records
  the last posted token per activity so the la-sync wait knows when to stop.
- **Countdown hero (widget):** when `endsAt` is in the future, the lock screen
  shows room → big countdown (34pt semibold, monospaced digits, tone accent) →
  title (1 line) → body (at most 3 lines; still 2 with buttons). The expanded
  island puts the countdown large in the trailing region (step small above it)
  and the room + title leading. Compact island unchanged. Without `endsAt` the
  layout is exactly as before. New `countdown` preview state and debug demo
  card (pre-meeting: hours-long timer, long body, no buttons).

### Contract deviations

None. The silent push is used exactly as specified
(`apns-push-type: background`, `apns-priority: 5`,
`{"aps":{"content-available":1},"construct":"la-sync"}` to the normal device
token, topic = bundle id).

Note for the server: the widget draws buttons whenever `actions` is non-empty,
including on countdown cards. Sinan wants pre-meeting cards without buttons, so
leave `actions` out for those.

### Tested

- Release archive of all five targets builds cleanly; all signed Apple
  Development with the App Group; the built Info.plist carries both modes.
- Countdown layout checked on the iOS 27 simulator lock screen with the debug
  demo: the pre-meeting card (2:16:xx, title, 2 body lines) and the warning
  card (countdown + progress + 2 buttons) fit the height cap with nothing
  clipped. Layout approved by Sinan.
- **Silent push not verified locally.** `xcrun simctl push` with the la-sync
  payload is refused by the simulator's SpringBoard ("Unable to launch
  com.wunnle.construct because this app doesn't declare the proper
  UIBackgroundMode", reason Disabled), both suspended and terminated, even
  after a clean reinstall whose installed Info.plist lists
  `remote-notification`. Looks like a simulator limitation; needs the device
  test below.
- Needs the phone: Bender's terminated-app test (reboot, don't open
  Construct, push-start, check `lastRegister` / `lastReconcile`); normal
  message notifications, Reply from a notification, and Shortcuts still working.
  Debug builds log `live-activity la-sync done: …` when the handler finishes.

### Finding: can a push-started activity end itself without the app?

Not with a per-activity token alone. `staleDate` only marks the card stale
(`context.isStale`); it doesn't remove it. iOS ends a Live Activity on its own
after 8 hours and leaves it on the lock screen for up to 4 more, which matches
the "stays for hours" reports. An `end` push needs the update token, which is
exactly what's missing.

The better option is **broadcast push (iOS 18+)**: enable Broadcast
capability for the App ID, create a channel via APNs channel management, and
put `"input-push-channel": "<channelId>"` in the push-to-start payload. The
activity then subscribes to the channel, and the server can update or `end`
it (including a `dismissal-date`) by pushing to the channel
(`apns-channel-id`, `/4/broadcasts/apps/<bundleId>`), with no update token and
no app wake at all. The la-sync path and the stale-date backstop would stay as
fallbacks. Not implemented; it's a server + App ID change.

## Morning card (tiles)

Branch: `mac/morning-card`. Not merged.

### Contract addition

ContentState gains an optional `tiles` (lenient decode, identical in the app
and widget copies):

```
tiles: [Tile]?          // at most 2 are drawn
Tile { icon: String, value: String, sub: String?, tone: String? }
```

**Deviation, at Sinan's request: `icon` is an SF Symbol name**, e.g.
`sun.max.fill`, `cloud.sun.fill`, `cloud.rain.fill`, `moon.zzz.fill`, drawn as
a white glyph. A string that isn't a symbol name is drawn as text, so an emoji
still renders, but send symbol names. `tone` uses the card's values and tints
`sub` (success green, warning amber, error red; missing/neutral → secondary).

### Layout

With `tiles`, the lock screen draws two equal rounded tiles side by side
(icon + large value, `sub` beneath), then the body (max 2 lines). Also at
Sinan's request: no avatar, no room name, no title; and no countdown, progress
or buttons (the card ignores `endsAt`, `progress` and `actions`). Without
`tiles` nothing changes. Expanded island: room label and step on top, tiles and
body below. Compact island: the first tile's icon + value.

### Tested

Debug build on the iOS 27 simulator: both #Preview states are also run as the
debug demo, and `-LiveActivityDemo morning` starts just those two. "Normal"
(sun, 7h 12 "Slept well" green) and "short night + rain" (rain, 5h 04 "Short
night" amber, body truncated at two lines) both fit the lock-screen height.
Not yet on the phone.
