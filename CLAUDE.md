# Construct — notes for agents

## The native app loads the deployed site

The personal iPhone and Mac builds run in Capacitor's **remote mode**
(`npm run sync:ios:remote`): the WebView loads https://construct.kafagoz.com, so a
push to `main` reaches the installed apps on their next launch or Reload, with no
rebuild. Native code (Swift, plugins, entitlements, assets, Info.plist) still only
changes with a build and install.

So the web code you push can be **newer than the native code it runs on**. Every
call into native code (`registerPlugin` plugins in `src/lib/liveActivity.ts`,
`useSpeechDictation`, `@capacitor/*` plugins) must survive the method not existing
yet: catch the rejection and fall back to the old behaviour or do nothing, never
break the screen. Ship the native half before relying on it.

Release/App Store builds must bundle the web app instead (`npm run sync:ios`);
see the Release section of TODO.md.
