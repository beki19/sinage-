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
                                                               │ polls every 30 s
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
3. **Playback.** The app fetches its *manifest* (the playlist with every item's type, duration and checksum), downloads anything new, verifies each file's SHA-256, deletes files no longer used, and loops the playlist. Images show for their set duration; videos play to the end.
4. **Updates.** Every 30 s the app re-checks the manifest. A `version` hash changes whenever the playlist or assignment changes, so the screen switches over without anyone touching it.
5. **Offline.** The last manifest and all media are kept on the device, so a screen keeps playing if Wi‑Fi or the server drops.

## CMS server structure (`cms/`)

| File | What it does |
|---|---|
| `src/server.ts` | Starts the server, reads settings (`PORT`, `ADMIN_PASSWORD`, `DATA_DIR`, `MAX_UPLOAD_MB`). |
| `src/app.ts` | All API routes: login, media, playlists, devices, pairing, player manifest and downloads. |
| `src/store.ts` | Data model and a small JSON-file database (no database server to install). |
| `public/` | The web admin UI: one page, plain HTML/CSS/JS, no build step. |
| `test/` | Automated tests that run a full pairing → manifest → download flow. |

**Data model**

- **Media**: name, image or video, file, size, SHA-256 checksum.
- **Playlist**: name, ordered items (media + seconds on screen).
- **Device**: name, assigned playlist, last seen (online/offline), secret token, model info.

**Security**: admin pages need the admin password (session token). Each screen has its own secret token and can only read its manifest and media. Removing a device in the admin UI cuts it off immediately, and the app goes back to the pairing screen.

## Android player structure (`android/`)

Kotlin, min Android 6.0, works on phones, tablets and Android TV. Uses Media3/ExoPlayer for video.

| File | What it does |
|---|---|
| `MainActivity.kt` | Fullscreen, screen always on; switches between Setup, Pairing and Playback screens. |
| `ApiClient.kt` | Talks to the CMS (register, pair status, manifest, downloads). |
| `Models.kt` | Manifest and pairing data, parsed from the CMS's JSON. |
| `ContentCache.kt` | Downloads, checksums, and cleans up media files on the device. |
| `PlaylistPlayer.kt` | Loops items: images in an image view, videos in ExoPlayer, cross-screen. |
| `Prefs.kt` | Saves server address, device token and last manifest. |
| `BootReceiver.kt` | Starts the player automatically when the device powers on. |

## Deliberately left for later

Scheduling (dayparting), multi-zone layouts, multiple admin users, screenshots from screens, and remote reboot. The structure leaves room for each; tell me which matter to you.
