# TODO

## Native iOS app (Capacitor)

- [x] **Fix top/bottom gaps in native app when composer is focused** (fixed 2026-07-17:
  `contentInset: 'never'`, Keyboard plugin `resize: 'none'` + native keyboard events
  driving the `--vv-*` vars, accessory bar hidden, safe-area padding on
  `.room-list-body` and `.sidebar-footer`)
  - Symptom: black band above the header (status bar / Dynamic Island area) at all times,
    and a second black band between the composer and the keyboard accessory bar while
    an input is focused.
  - Likely causes, in combination:
    - `contentInset: 'always'` in `capacitor.config.ts` insets the webview below the
      status bar instead of drawing under it (top gap). Try `'never'` +
      `viewport-fit=cover` + `env(safe-area-inset-*)` padding in CSS.
    - Double keyboard compensation (bottom gap): WKWebView natively resizes when the
      keyboard opens, *and* `useVisualViewportVars` shrinks the layout via
      `--vv-height`. That hook was tuned for Safari/PWA where the webview does not
      resize. Either install `@capacitor/keyboard` with `resize: 'none'` and let the
      CSS vars do the work, or skip the vv vars when running native
      (`Capacitor.isNativePlatform()`).
- [ ] Point client API calls at an absolute base URL when running native.
  Relative `/api/...` fetches resolve against the local webview origin, so
  room-intent polling and the active-room beacon silently no-op in the app.
- [x] Push notifications for the native app — **working end to end 2026-07-20**
  (alert delivery, inline reply, markdown-stripped body, custom expanded view).
  - **Gotcha that cost a session:** the first auth key was created as a
    *Sandbox-only* APNs key. developer.apple.com → Keys offers a sandbox-restricted
    variant alongside the normal one; the normal key works for **both**
    environments and is the one you want. A sandbox-only key returns
    `403 BadEnvironmentKeyInToken` from `api.push.apple.com`, which the gateway's
    original fallback (`400 BadDeviceToken` only) did not catch — so every push was
    dropped silently and the endpoint still answered `200 {"rejected":[]}`.
    `matrix-push.js` now falls back on both errors.
  - **Probing the gateway without a device:** POST a notification with a bogus
    64-zero pushkey to `/_matrix/push/v1/notify`. `rejected: [token]` means Apple
    authenticated the JWT and only refused the fake token — credentials are good.
    `rejected: []` means missing env vars, a bad JWT, or a connection failure; the
    handler cannot distinguish them from outside.
- [ ] Richer rendering in the expanded notification view
  (`ios/App/ConstructNotificationContent/NotificationViewController.swift`).
  Currently renders bold, italic, inline code, links and fenced code blocks into
  a single `UILabel`. Not handled: cards, accordions/disclosure groups, tables,
  blockquote styling, images, and bullet/numbered list indentation — bender
  emits these and they flatten to plain paragraphs.
  - A `UILabel` is the ceiling here. Anything with structure wants a stack of
    views (or SwiftUI via `UIHostingController`), plus a real block-level parse
    rather than the current split-on-fences approach.
  - The view is sized by `preferredContentSize`, so growing content needs that
    recomputed; `UNNotificationExtensionInitialContentSizeRatio` only sets the
    starting height.
  - Interactive elements (a tappable accordion) need
    `UNNotificationExtensionUserInteractionEnabled`, already set — but iOS only
    allows limited interaction, so an accordion may have to render expanded.

- [ ] Notification content extension — **gotchas, both cost hours on 2026-07-20**:
  1. **Link the extension point's framework explicitly.** Swift's
     `import UserNotificationsUI` does *not* autolink it. Without it the
     extension launches, then fails with `Unable to find NSExtensionContextClass
     (_UNNotificationContentExtensionVendorContext)` and iOS renders an **empty
     panel with no crash**. Fixed via `OTHER_LDFLAGS` on the target.
  2. **An empty expanded view gives you nothing to go on** — no crash report, no
     visible error. Get the device log instead of guessing:
     `idevicesyslog -u <udid> > log.txt`, then grep for the extension name.
     Do this *first*; the failure reason is stated plainly in the log.
  3. **Test with a freshly delivered notification.** iOS binds a notification to
     the content extension present at delivery time, so long-pressing an older
     notification won't exercise a newly installed extension.
  4. The extension loads via `NSExtensionMainStoryboard` (`MainInterface`).
     `NSExtensionPrincipalClass` also launched fine, so it is not required —
     but the storyboard matches Apple's template and is what's proven here.

- [ ] Gate `DebugOverlay` (and the tap-version debug trigger) behind a dev flag so
  they stay out of release builds.

## Release / App Store

- [x] Enroll in Apple Developer Program (done 2026-07-20).
- [ ] Archive and upload first TestFlight build.
- [ ] Push-driven Live Activity updates — **shipped 2026-07-20, untested end to
  end**. Activity push tokens register via `api/live-activity.js`; the gateway
  pushes the reply as an `end` event so a reply slower than `AskConstructIntent`'s
  30s polling window still lands. Verify: ask via Shortcut, lock, wait past 30s.
  - The gateway sends `event: "end"`, not `"update"`. Correct while streaming is
    off (one answer per ask) — but if bender ever sends two messages for one
    ask, the first ends the activity and the second is lost.
- [ ] **Flip `aps-environment` to `production`** in `ios/App/App/App.entitlements`
  before any TestFlight/App Store build — it is `development` for on-device debug
  builds, and TestFlight uses the production APNs environment. Getting this wrong
  fails silently, exactly like the sandbox-key issue above.
- [ ] Public build config: build **without** `VITE_INTENT_SECRET` (personal endpoints
  off), personal build keeps it via local `.env`. Never ship the secret in the
  public binary.
- [ ] Final app name + icon (bundle ID `com.wunnle.construct` stays regardless).
- [ ] App Review prep: privacy policy URL, App Privacy questionnaire, and UGC
  guideline 1.2 — report-content and block-user affordances.

## Mac app (later)

- [ ] Construct on macOS. Four routes, cheapest first — try them in this order:
  1. **PWA, "Add to Dock" in Safari** — zero code. The deployed web app already
     has a service worker + VAPID, and macOS Safari 16.4+ supports Web Push, so
     the existing web path in `api/matrix-push.js` delivers to the Mac with no
     new key, target, or infra. Registers as another device under
     `app_id com.kafagoz.construct`.
  2. **"Designed for iPad"** — `TARGETED_DEVICE_FAMILY` is already `"1,2"`, so
     the current binary runs on Apple Silicon; a checkbox at distribution time.
     iPad-shaped window and iPad idioms.
  3. **Mac Catalyst** — a real Mac app (resizable windows, menu bar). Needs
     `SUPPORTS_MACCATALYST`, a macOS provisioning profile, and native auditing:
     `@capacitor/keyboard` is iOS-only, and **ActivityKit is unavailable on
     Catalyst** — the Live Activity code in `AppDelegate.swift` needs
     `#if !targetEnvironment(macCatalyst)` guards, not just its current
     `#available(iOS 16.2)` ones, which compile and then fail to link. Widget
     extension needs excluding. ~a day.
  4. **Electron/Tauri** — most control, hard to justify against route 1.
  - **Live Activities do not exist on macOS in any form.** If the Mac experience
    should centre on ambient agent progress the way iOS does, none of these give
    that — the equivalent is a menu bar item, which is a different app.

## Server / infra

- [ ] Rotate `MATRIX_ACCESS_TOKEN` in Vercel — the pre-fix media proxy would send it
  to arbitrary hosts, so treat the old token as burned.
- [ ] `room-intent` reliability: single in-memory slot on a serverless function —
  intents vanish when the poll lands on a different lambda instance, and any device
  can consume an intent meant for another. Move the slot to Vercel Blob/KV and key
  it by target device.
