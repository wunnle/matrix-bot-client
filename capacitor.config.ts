import type { CapacitorConfig } from '@capacitor/cli';

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
