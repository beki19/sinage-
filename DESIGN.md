# Digital Signage: Design Plan

Two pieces talk over plain HTTP/JSON:

```
 ┌──────────────────────────── CMS server (Node + TypeScript) ───────────────────────────┐
 │  Web admin UI (browser)        REST API                     Storage                    │
 │  - log in                      /api/login                   data/db.json  (records)    │
 │  - upload images/videos  ───▶  /api/media                   data/media/   (files)      │
 │  - build playlists             /api/playlists                                          │
 │  - pair + manage screens       /api/devices                                            │
 │                                /api/player/*  ◀─────────────┐                          │
 └─────────────────────────────────────────────────────────────┼──────────────────────────┘
                                                               │ polls every 15 s
                                               ┌───────────────┴────────────────┐
                                               │  Android player app (Kotlin)   │
                                               │  - shows pairing code          │
                                               │  - downloads + caches media    │
                                               │  - loops playlist fullscreen   │
                                               │  - keeps playing offline       │
                                               └────────────────────────────────┘
```

## How a screen gets content

1. **Install the app** on an Android TV box, tablet or stick, enter the CMS address once (e.g. `http://192.168.1.10:3000`).
2. **Pairing.** The app asks the CMS for a 6-letter code and shows it full screen. In the admin UI you type that code, a name ("Lobby TV") and pick a playlist. The app then receives its own secret device token. Codes expire after 15 minutes.
3. **Playback.** The app fetches its *manifest*: the media files it needs (with SHA-256 checksums), one or more *programs* (a playlist is a program with one fullscreen zone; a layout is a program with several zones), the default program, the schedule, and any pending remote commands. It downloads anything new, verifies each file, deletes files no longer used, and plays the active program: each zone loops its own items. Images, text and web pages show for their set duration; videos play to the end; live streams play for their set time, or nonstop when alone.
4. **Updates.** Every 15 s the app re-checks the manifest. A `version` hash changes whenever the content or schedule changes, so the screen switches over without anyone touching it. Remote commands ride along but don't change the version.
5. **Scheduling and dates.** The screen picks the active program, and which items are inside their start/end dates, by its *own* clock, so both keep working offline.
6. **Offline.** The last manifest and all media are kept on the device, so a screen keeps playing if Wi‑Fi or the server drops. (Web pages, YouTube and live streams need the network.)

## CMS server structure (`cms/`)

| File | What it does |
|---|---|
| `src/server.ts` | Starts the server, reads settings (`PORT`, `ADMIN_PASSWORD`, `DATA_DIR`, `MAX_UPLOAD_MB`). |
| `src/app.ts` | All API routes: login and accounts, media, playlists, layouts, groups, screens, remote commands, screenshots, dashboard and alerts, pairing, player manifest and downloads. |
| `src/store.ts` | Data model and a small JSON-file database (no database server to install). |
| `public/` | The web admin UI: one page, plain HTML/CSS/JS, no build step. |
| `test/` | Automated tests for every feature, from pairing through manifest, schedules, commands and alerts. |

**Data model**

- **Media**: name, image or video, file, size, SHA-256 checksum.
- **Playlist**: name, ordered items. An item is media, text (colours, ticker on/off), a web page/YouTube link, or a live stream, with seconds on screen and optional start/end date-times.
- **Layout**: name and up to 12 zones (position and size in percent of the screen), each with a playlist.
- **Group**: name, default playlist or layout, schedule. A screen in a group follows the group.
- **Device** (screen): name, default playlist or layout, schedule, group, pending commands, last screenshot, last seen, secret token, model info.
- **Schedule slot**: days of the week, start and end time (may run past midnight), playlist or layout. First match wins.
- **User**: username, role (admin, editor, viewer), scrypt password hash.
- **Settings and events**: the offline-alert webhook and threshold; a log of screens going offline and coming back.

Data written by older versions is upgraded in place when the server starts.

**Security**: admin pages need a login (session token). Viewers can only read; only admins manage accounts and alert settings. Each screen has its own secret token and can only read its manifest and media, report command results and upload its screenshot. Removing a device in the admin UI cuts it off immediately, and the app goes back to the pairing screen.

## Android player structure (`android/`)

Kotlin, min Android 6.0, works on phones, tablets and Android TV. Uses Media3/ExoPlayer for video and HLS streams, and a WebView for web pages and YouTube.

| File | What it does |
|---|---|
| `MainActivity.kt` | Fullscreen, screen always on; switches between Setup, Pairing and Playback; follows the schedule; runs remote commands and takes screenshots. |
| `ApiClient.kt` | Talks to the CMS (register, pair status, manifest, downloads, command results, screenshot upload). |
| `Models.kt` | Manifest, programs, zones, items, schedule and commands, parsed from the CMS's JSON (older manifests too). |
| `ContentCache.kt` | Downloads, checksums, and cleans up media files on the device. |
| `ScreenPlayer.kt` | Plays a program: one zone per rectangle of the screen (`ZoneLayout`). |
| `PlaylistPlayer.kt` | Loops one zone's items: images, videos, streams, web pages, YouTube, text and tickers, skipping items outside their dates. |
| `Prefs.kt` | Saves server address, device token and last manifest. |
| `BootReceiver.kt` | Starts the player automatically when the device powers on. |

## Limits worth knowing

- **Reboot** needs a rooted device (`su`); others restart the app instead.
- **Screenshots** on Android 8 and newer include video and web pages; on Android 6–7 video areas come out black.
- **Several video zones** each need a hardware video decoder; cheap TV boxes may only manage one or two at once.
- **YouTube** plays muted (autoplay rules) and depends on YouTube allowing the video to be embedded.
