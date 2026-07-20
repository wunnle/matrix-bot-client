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
- [ ] Push notifications for the native app — **server side verified 2026-07-20**,
  device side untested. Enrollment done, entitlement enabled, APNs key + the four
  `APNS_*` env vars live in Vercel. Remaining: build to device, confirm the pusher
  registers (`app_id com.wunnle.construct.ios`, 64-char hex pushkey), send a real
  message.
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
- [ ] Gate `DebugOverlay` (and the tap-version debug trigger) behind a dev flag so
  they stay out of release builds.

## Release / App Store

- [x] Enroll in Apple Developer Program (done 2026-07-20).
- [ ] Archive and upload first TestFlight build.
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

## Server / infra

- [ ] Rotate `MATRIX_ACCESS_TOKEN` in Vercel — the pre-fix media proxy would send it
  to arbitrary hosts, so treat the old token as burned.
- [ ] `room-intent` reliability: single in-memory slot on a serverless function —
  intents vanish when the poll lands on a different lambda instance, and any device
  can consume an intent meant for another. Move the slot to Vercel Blob/KV and key
  it by target device.
