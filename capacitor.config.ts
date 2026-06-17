import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.wunnle.construct',
  appName: 'Construct',
  webDir: 'dist',
  ios: {
    contentInset: 'always',
  },
  server: {
    // Allow WKWebView to use SharedArrayBuffer (needed for matrix-sdk-crypto-wasm)
    androidScheme: 'https',
  },
};

export default config;
