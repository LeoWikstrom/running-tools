# running-tools

Small web tools for runners — client-only static apps, no backends, no accounts. An npm
workspace monorepo; shared engine code lives in `packages/core`, apps in `apps/*`.

Live site: https://leowikstrom.github.io/running-tools/

- **RunTour** (`apps/runtour`) — an audio guide for running: generate a route, find places
  along it with Wikipedia texts, and let GPS trigger the narration as you pass.
  Also a native Android wrapper (`android/runtour`, Gradle-free build) —
  [download the APK](https://github.com/LeoWikstrom/running-tools/releases/latest/download/runtour.apk).
- **Profile Course** (`apps/profile-course`) — upload a race GPX, pick a start point and
  radius, get a runnable course nearby whose elevation profile matches the race.

The landing page is `site/`; `.github/workflows/pages.yml` builds every app in `apps/*` and
deploys the lot to GitHub Pages on each push to `main`. A new app only needs a card added to
`site/index.html`.

## Development

```
npm install
npm test
npm run lint
npm run dev -w runtour          # or -w profile-course
android/runtour/build.sh        # signed APK (SKIP_WEB=1 to skip the web build)
android/runtour/release.sh      # build + publish APK as a GitHub Release
```

## First-push checklist

1. `gh repo create LeoWikstrom/running-tools --public --source . --push`
2. Repo Settings → Pages → Build and deployment → Source: **GitHub Actions**
   (or `gh api repos/LeoWikstrom/running-tools/pages -X POST -f build_type=workflow`).
3. `android/runtour/release.sh` to publish the first APK.
4. Archive the old `LeoWikstrom/profile-course` repo with a README pointing here.
