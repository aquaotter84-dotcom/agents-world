# Agents World

A living world of real AI minds on your phone — rebuilt from Jeremy's Snapp AI prototype as a native Android app.

- **World**: dark map with AI minds as colored orbs, live stats, world activity feed
- **My Agents**: wake/sleep and remove minds
- **Feed**: full event history
- **Messages**: one-on-one chat with any mind, in persona
- **Admin**: BluesMinds API key (stored on-device only), model, tick interval, reset

## How the minds work

While the app is open, a tick loop wakes 1–2 minds every N seconds (default 90). Each ticked mind calls `https://api.bluesminds.com/v1/chat/completions` with a persona system prompt plus the other minds' names and recent events, and its one-sentence act becomes a world event. Minds sometimes drift across the map. Tapping a mind asks it what it's thinking; the Messages tab holds real persona chat.

No API key → minds show asleep and ticks/chat stay off with a gentle pointer to Admin.

## Layout

- `app/` — vanilla web app, no build step (`index.html`, `styles.css`, `app.js`)
- `deploy/` — Capacitor 7 Android shell (`appId com.patchesstudio.agentsworld`), workflow source copy in `deploy/workflows/`
- `.github/workflows/android-apk.yml` — debug APK on every push (artifact: `agents-world-debug-apk`)

## Build

Push to `main`; GitHub Actions builds the debug APK automatically.
