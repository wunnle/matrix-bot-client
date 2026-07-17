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
- [ ] Push notifications for the native app: Web Push doesn't exist in WKWebView.
  Add `@capacitor/push-notifications` (APNs), register the APNs token as the Matrix
  pusher pushkey, and teach `api/matrix-push.js` to deliver APNs pushkeys
  alongside Web Push subscriptions.
- [ ] Gate `DebugOverlay` (and the tap-version debug trigger) behind a dev flag so
  they stay out of release builds.

## Release / App Store

- [ ] Enroll in Apple Developer Program; archive and upload first TestFlight build.
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
