# Digital Signage

A content management system (CMS) you run on a computer or server, and an Android app that turns any Android TV box, stick, tablet or smart display into a signage screen. See [DESIGN.md](DESIGN.md) for how the pieces fit together.

```
signage/
├── cms/        Node + TypeScript server and web admin page
├── android/    Kotlin player app
└── .github/    GitHub Actions: CMS tests and an APK build
```

## 1. Run the CMS

Needs Node.js 20 or newer.

```bash
cd cms
npm install
ADMIN_PASSWORD=choose-a-password npm run dev     # development, reloads on change
```

For production:

```bash
npm run build
ADMIN_PASSWORD=choose-a-password PORT=3000 npm start
```

Or with Docker:

```bash
docker build -t signage-cms cms
docker run -d -p 3000:3000 -e ADMIN_PASSWORD=choose-a-password -v signage-data:/data signage-cms
```

Open `http://<this-computer's-IP>:3000` in a browser and log in.

| Setting | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | `admin` | Password for the admin page. Always set this. |
| `PORT` | `3000` | Port to listen on. |
| `DATA_DIR` | `./data` | Where the database file and uploaded media are kept. Back this folder up. |
| `MAX_UPLOAD_MB` | `2048` | Largest single upload. |

Run the tests with `npm test`.

## 2. Build and install the Android player

Open the `android/` folder in **Android Studio** (Ladybug or newer), let it sync, then **Build → Build APK(s)**. Or from a terminal with the Android SDK installed:

```bash
cd android
./gradlew assembleRelease
# APK: android/app/build/outputs/apk/release/app-release.apk
```

If you push this folder to GitHub, the included workflow builds the APK for you on every push. Download it from the workflow run's **Artifacts** section.

Install on a device with `adb install app-release.apk`, or copy the APK over and open it (allow "install unknown apps").

Requirements: Android 6.0 or newer. Works with touch screens and TV remotes.

## 3. Put content on a screen

1. **Media tab**: drag in images (JPG, PNG, WebP, GIF) and videos (MP4/H.264 is the safest choice for cheap TV boxes).
2. **Playlists tab**: create a playlist, click media to add it, set how many seconds each image shows, reorder with the arrows, and **Save**.
3. Open the player app on the screen. Enter the CMS address, e.g. `http://192.168.1.10:3000`. The screen shows a 6-letter code.
4. **Screens tab**: type the code, give the screen a name and pick a playlist, then **Pair screen**.

The screen downloads everything, then loops the playlist. When you edit a playlist or assign a different one, screens pick it up within 30 seconds. Screens keep playing from their saved copy if the network or CMS goes down.

**On the screen**: press **Back** or **Menu** on the remote, or tap the screen five times quickly, to open the settings menu (change server, unpair, exit).

## Kiosk tips

- The app starts automatically after a reboot. On Android 10 and newer, some devices block that; on those, set the player as the default **Home** app, or use the device's own "auto-start app" setting (common on signage boxes).
- Turn off the device's screensaver/sleep in Android settings.
- Give the CMS computer a fixed IP address on your network so screens can always find it.
- If the CMS is reachable from the internet, put it behind HTTPS (e.g. Caddy or nginx) and use an `https://` address in the app.

## Not built yet

Scheduling by time of day, split-screen layouts, multiple admin accounts, screenshots from screens, and remote reboot.
