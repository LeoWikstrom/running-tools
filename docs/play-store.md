# Play Store: organization account + publishing the three apps

Checklist for publishing RunTour, BusTour and RaceTwin via an **organization**
developer account (skips the personal-account requirement of a 12-tester,
14-day closed test before production). Written 2026-11-03 — Google changes
these rules often; where a step says "check current", do.

## Part A — The organization account

- [ ] **Have a legal organization.** Any registered form works (AB,
      enskild firma with org number, etc.). Decide *which* org publishes —
      the org's name appears on every listing and plausibly owns the apps.
- [ ] **Get a D-U-N-S number** for that org (required since 2023). Free via
      Dun & Bradstreet (dnb.com, Swedish orgs often already have one —
      search first). Allow days to a couple of weeks if newly issued.
- [ ] **Create/choose a Google account** for the console — ideally on the
      org's own domain, not a personal gmail; it becomes the owner.
- [ ] **Sign up** at play.google.com/console/signup → "An organization".
      One-time $25 fee. Enter the D-U-N-S number; Google pulls the org
      record and they must match (legal name, address).
- [ ] **Pass verification**: org documents if asked (registration
      certificate), website on the org's domain, an email address on that
      domain, phone verification, and ID verification for the account owner.
- [ ] **Payment profile** in the organization's name (even for free apps).
- [ ] **DSA trader declaration** (EU): free hobby apps with no monetization
      can usually declare non-trader; a trader must show address + contact
      details publicly on every listing. Decide before the first listing
      goes live.

## Part B — Prepare the apps (once)

- [ ] **AABs, not APKs.** New Play apps must upload App Bundles. The
      Gradle-free path: `aapt2 link --proto-format`, then
      `bundletool build-bundle` (bundletool is a jar; runs under the same
      JDK as the build). Add a `bundle.sh` beside each `build.sh`, one AAB
      per app id (runtour, bustour, racetwin).
- [ ] **Target API level**: Play requires targeting a recent Android
      (within ~1 year of the latest release). We target 34 — check the
      current requirement in the console and bump `API`/`--target-sdk-version`
      if needed.
- [ ] **Play App Signing** (mandatory): enroll each app. To keep upgrade
      compatibility with the sideloaded GitHub-release APKs, **export the
      existing runtour.jks key into Play App Signing** (console offers the
      `pepk` tool) instead of letting Google generate a new key. Create a
      separate *upload* key while at it — then a leaked upload key is
      recoverable.
- [ ] **versionCode**: the date-derived scheme (`%Y%m%d%H`) is fine; Play
      only needs it strictly increasing per upload.
- [ ] **Manifest checks**:
  - [ ] RunTour/BusTour: foreground service must declare
        `android:foregroundServiceType="location"` and the matching
        `FOREGROUND_SERVICE_LOCATION` permission (required at target 34).
  - [ ] No background-location permission anywhere (it triggers a much
        heavier review) — the service is foreground-only, keep it that way.
- [ ] **Privacy policy pages**: one URL per app, required even with no data
      collection. A page per app on the Pages site (`site/`) is enough:
      what permissions are used, everything processed on-device, no
      accounts, no analytics.

## Part C — Console setup, per app (×3)

- [ ] **Create app**: name, default language, App (not game), Free.
      Free is permanent — a free app can never become paid.
- [ ] **Store listing**: short description (≤80 chars), full description
      (≤4000), 512×512 PNG icon, 1024×500 feature graphic, ≥2 phone
      screenshots (8" + 10" tablet shots optional but help).
- [ ] **App content** section:
  - [ ] Privacy policy URL.
  - [ ] Ads: none.
  - [ ] Content rating questionnaire (IARC) — utility/no UGC answers.
  - [ ] Target audience: 18+ (or 13+); not child-directed.
  - [ ] Data safety form: location is *used* but processed on-device and
        never transmitted to us (there is no server) — declare accordingly
        ("no data collected or shared"; network fetches go to OSM/Wikipedia
        as content downloads, not data collection).
  - [ ] Location permission declaration for RunTour/BusTour: explain the
        GPS-triggered narration; Google sometimes asks for a short demo
        video of the permission in use.
- [ ] **Countries**: pick (all, or start with Sweden + neighbours).
- [ ] **First release**: upload the AAB to **internal testing**, install
      via the Play link on a real phone, verify GPS/foreground service
      survived Google's re-signing — then promote to **production** (org
      account: no tester-count gate).
- [ ] Expect first-app review to take several days, longer for the two
      location apps.

## Part D — Ongoing

- [ ] Updates: bump nothing by hand — rebuild (new date versionCode),
      upload the AAB to production, staged rollout optional.
- [ ] Keep the GitHub Release APKs signed with the same key as Play
      (that's what the key migration in Part B buys): users can switch
      install source without uninstalling.
- [ ] Watch the console inbox — policy declarations get re-asked yearly-ish
      and unanswered ones take the app down.
