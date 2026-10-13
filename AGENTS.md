# Plugin development instructions

Instructions for opencode agents working on the Paarrot plugin system in this repo.

## Architecture

- Plugin host: `overlay/src/app/utils/pluginHost.ts`. Electron uses `window.electron.plugins`, Android uses the Capacitor `PluginStorage` plugin, web returns null.
- Native Android host: `android/app/src/main/java/com/paarrot/app/PluginStoragePlugin.kt` (download zip, unzip with zip-slip guard, list, uninstall, readPluginCode). Registered in `MainActivity.java`.
- Loader: `cinny/src/app/features/settings/plugins/PluginLoader.tsx`, mounted in `ClientRoot.tsx`. It evaluates `index.js` with `new Function` for CommonJS and falls back to a data-URL import for ESM.
- Registry and marketplace: `PluginAPI.ts` persists both to `localStorage`. Enabled state survives restarts. Plugins load at app start, so enabling a plugin requires an app restart.

## Plugin context contract

- `createPluginContext` from `@paarrot/plugin-manager` provides: `commands`, `messages`, `ui`, `settings`, `themes`, `events`, `timers`, `log`, `warn`, `error`.
- `PluginLoader` adds compat fields on top: `matrixClient`, `matrix`, `React`, `lucide`. Plugins destructure these directly (for example `const { Link } = ctx.lucide`), so a missing field throws at `onLoad` and the plugin never runs. Keep the compat fields in sync between `cinny` and `overlay`. A missing `lucide` caused silent plugin failure on mobile, fixed in commit `1f16f5d`.

## UI locations

- Valid `UILocation` values: `room-header`, `message-actions`, `user-menu`, `room-menu`, `composer-actions`, `channel-list`, `direct-messages`, `home-section`, `search-notification-section`, `text-composer-toolbar`, `sidebar-actions`.
- Button slots render at all screen sizes. Nav-only locations (`channel-list`, `direct-messages`, `home-section`, `sidebar-actions`) have no surface in the single-column mobile UI, so plugins that only register there are invisible on phones.

## Mobile quirks

- Capacitor injects plugins on `Capacitor.Plugins` after the bridge is ready, and `registerPlugin` is often missing on Android. The `waitForBridge` fallback pattern in `overlay/src/app/utils/backgroundSync.ts` is the reference.
- No CSP is configured in `capacitor.config.json`, so `new Function` and data-URL imports work. Adding CSP would break plugin evaluation.
- WebView console logs reach logcat under the tag `Capacitor/Console`.

## Debugging on device

- Wireless adb: `adb connect <ip>:<port>`. The `adb tcpip` port persists until reboot, then resets to 5555. Android 11+ wireless debugging randomizes the port per reboot by design. Pinning needs root (`persist.adb.tcp.port`).
- Plugin files: `adb shell run-as com.paarrot.app cat files/plugins/<id>/index.js` works on debuggable builds.
- Enabled state: localStorage lives in `app_webview/Local Storage/leveldb`. Search for `plugin-manager:installed-plugins`.
- Live eval: the WebView devtools socket is `@webview_devtools_remote_<pid>`. Forward with `adb forward tcp:9222 localsocket:webview_devtools_remote_<pid>`. The socket may refuse HTTP and WebSocket requests from non-localhost hosts.
- To trigger plugin load logs: force-stop, start, then `logcat -d | grep PluginLoader`.
- Hotpatching the installed copy with `run-as` plus an app restart tests plugin changes without reinstalling.

## Marketplace

- Directory: `Paarrot/Plugin-Directory`. Entries are static JSON files. The `version` field is a manual snapshot and is never synced from the plugin repo.
- Updates go through PRs. `validate-pr.yml` validates and auto-merges. `update-index.yml` regenerates `index.json` from committed entries only.
- A plugin repo needs `index.js` and `plugin-metadata.json`. The directory `downloadUrl` is the GitHub archive zip.
- Bump the version in both the plugin repo metadata and the directory entry when shipping changes.

## Repo conventions

- Edit `overlay/` files, not `cinny` directly. `scripts/apply-overlay.mjs` layers the overlay onto the cinny submodule before every Android build.
- `android/gradlew` is not executable. Run it as `sh gradlew`.
- Use `scripts/push.sh` for commits. It skips the cinny submodule pointer and `gradlew`.
