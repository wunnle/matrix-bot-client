import type { CapacitorConfig } from '@capacitor/cli';

// Point the WebView at the deployed web app instead of the bundled copy, so a
// `git push` (Vercel auto-deploys) reaches the device on its next launch and
// only native changes need a rebuild. Opt-in per sync — release/App Store
// builds must stay self-contained, so plain `npx cap sync ios` still bundles:
//   npm run sync:ios          → bundled (release)
//   npm run sync:ios:remote   → loads https://construct.kafagoz.com
// Switching modes changes the WebView's origin, so local storage (login,
// the Matrix IndexedDB store, room order) starts fresh on the other side.
const remoteUrl = process.env.CAP_SERVER_URL

const config: CapacitorConfig = {
  appId: 'com.wunnle.construct',
  appName: 'Construct',
  webDir: 'dist',
  ios: {
    // Draw under the notch/home indicator; the CSS handles safe areas
    // (viewport-fit=cover + env(safe-area-inset-*) padding).
    contentInset: 'never',
  },
  server: {
    // Allow WKWebView to use SharedArrayBuffer (needed for matrix-sdk-crypto-wasm)
    androidScheme: 'https',
    ...(remoteUrl ? { url: remoteUrl } : {}),
  },
  plugins: {
    Keyboard: {
      // The layout already tracks the keyboard via visual-viewport CSS vars;
      // letting the webview also resize would compensate twice.
      resize: 'none',
    },
  },
};

export default config;
