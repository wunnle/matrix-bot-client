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
