# RunTour on iOS – plan

Nov 10, 2026 · @Leo

## Status (Nov 11, 2026)

Phase A scaffolding is built: `ios/runtour/` holds the XcodeGen `project.yml` and the
Swift wrapper (AppDelegate, WebViewController, AppSchemeHandler serving `www/` on
`runtour://app/`, sw.js 404s, external links to Safari). `.github/workflows/ios.yml`
builds the web app, bakes the icon from the Android artwork, generates the project and
runs one of two lanes: `simulator` (unsigned compile check, no Apple account needed,
kept green) and `testflight` (cloud-signed archive + upload; needs the four secrets
listed in the workflow header: APPLE_TEAM_ID, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8).

Leo's steps to reach TestFlight: enroll in the Apple Developer Program ($99/yr) →
App Store Connect → create an API key (Users and Access → Integrations, role
App Manager; note Key ID + Issuer ID, download the .p8) → register the app
(bundle id `se.eq2.runtour`, created automatically by the first signed build, or by
hand under Identifiers) → create the app record in App Store Connect pointing at that
bundle id → add the four GitHub secrets → run the iOS workflow with lane `testflight`
→ install via the TestFlight app on the iPhone.

Goal: the runtour web app as a native iOS app on the App Store, with run playback
(background GPS + audio) on par with the Android APK. Constraint that shapes everything:
development happens on a phone (Termux), there is **no Mac** — an iPhone is available for
testing. Everything macOS-only therefore runs on GitHub Actions macOS runners, and every
install goes through TestFlight.

## Architecture

A Swift WKWebView wrapper, the iOS sibling of `android/runtour`:

- **Assets.** The built `apps/runtour/dist/` is bundled into the app and served through a
  `WKURLSchemeHandler` on a custom scheme (e.g. `runtour://app/`). This is the analog of
  the Android asset interception and avoids `file://` CORS; like on Android, `sw.js`
  deliberately 404s so service-worker fetches never bypass the handler.
- **Bridge.** An injected `WKUserScript` exposes a `window.RunTour`-compatible object.
  iOS message handlers are asynchronous, unlike Android's synchronous
  `addJavascriptInterface`, so the synchronous bridge calls (`listTours`, `getTour`,
  `saveTour`, `runState`) need either `WKScriptMessageHandlerWithReply` plus an async shim
  in `src/native.ts`, or a small refactor making those call sites async. This is the one
  shared-code change the port needs; the callback-style calls (`synthesize`, `fetchText`,
  `downloadTourFile`) already fit the async model via `__rtResolve`.
- **Run playback — the key simplification.** With `UIBackgroundModes` `location` (+
  `audio`), the whole process including the WebView's JavaScript keeps running in the
  background. The TS trigger runtime (`packages/core/src/tour/runtime.ts`) can therefore
  drive the run directly — **no Swift port of the trigger algorithm**, no third copy
  beside `runtime.ts` and `RunRuntime.java`. Native side only provides:
  - `CLLocationManager` with `allowsBackgroundLocationUpdates = true`,
    `pausesLocationUpdatesAutomatically = false`, fixes pushed into the page;
  - narration through `AVSpeechSynthesizer` / `AVAudioPlayer` (WebView speech is
    unreliable in the background) on an `AVAudioSession` configured `.playback` with
    duck-others, mirroring the Android audio focus behaviour;
  - local notifications (`UNUserNotificationCenter`) for the run state.
- **Known limitation: area downloads.** iOS has no foreground-service equivalent; without
  active background location, JS fetches stop ~30 s after minimising
  (`beginBackgroundTask` grace only). Area downloads happen with the screen on; a local
  notification announces completion. Acceptable for v1 — downloads take a few minutes.
- **BusTour.** Same wrapper, second bundle id and asset set (`dist-bus/`), decided later —
  ship RunTour first.

## Building and shipping without a Mac

1. **Apple Developer Program** — $99/year, required for TestFlight and the App Store.
   Create the app record in App Store Connect; generate an **App Store Connect API key**
   (replaces interactive Apple ID login in CI).
2. **Project definition.** No hand-maintained `.pbxproj`: an `ios/runtour/project.yml`
   for **XcodeGen** is checked in, the Xcode project is generated fresh in CI. Swift
   sources + `Info.plist` keys (background modes, location usage strings) live in git.
3. **CI pipeline** (`.github/workflows/ios.yml`, macOS runner):
   `npm run build` → `xcodegen` → `xcodebuild archive` → signed IPA → upload to
   TestFlight. Signing certificates/profiles managed by **fastlane** (`match` with an
   encrypted repo, or `cert`/`sigh` against the API key); upload via `fastlane pilot` or
   `xcrun altool`. Note macOS CI minutes bill at 10× (free tier ≈ 200 macOS min/month);
   builds are triggered by tag or manually, not on every push.
4. **Testing.** Install each build via the TestFlight app on the iPhone. There is no
   Safari Web Inspector without a Mac, so debug builds embed a log overlay (or eruda);
   TestFlight provides crash logs. The iteration loop is slow (~15–30 min per build) —
   develop everything testable in mobile Safari first, use CI builds only for
   native-bridge and background behaviour.

## Phases

- **A — pipeline.** Developer account, app record, API key, XcodeGen project, CI build of
  a hello-world WKWebView that loads the bundled runtour dist. Success: installed from
  TestFlight on the iPhone.
- **B — preparation parity.** Scheme handler, bridge (tours storage, `fetchText` proxy for
  CORS-blocked hosts, TTS synthesis to files), async-shim change in `native.ts`. Success:
  prepare a tour end-to-end on the iPhone.
- **C — run playback.** Location + audio background modes, CLLocationManager feed,
  AVSpeechSynthesizer/AVAudioPlayer output, battery check on a real run. Success: a field
  test like the Android phase 4 one.
- **D — polish.** Download-complete notification, app icons/launch screen, decide on
  BusTour.
- **E — App Store.** Privacy policy URL, `NSLocationWhenInUseUsageDescription` /
  `NSLocationAlwaysAndWhenInUseUsageDescription` texts, privacy manifest, screenshots,
  review submission. Rejection risk is low: offline maps, GPS triggering and TTS make it
  clearly an app, not a packaged website.

## Costs and risks

- $99/year developer program; macOS CI minutes (manageable with tag-triggered builds).
- Slow debug loop without a Mac — mitigated by keeping logic in the shared web code.
- App review opinions on background location (justified: core feature).
- WKWebView JS throttling in background with only the `location` mode active is
  well-trodden but must be verified early (phase C field test).
