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

Open `http://<this-computer's-IP>:3000` in a browser and log in with username `admin` and your `ADMIN_PASSWORD`. To give other people access, add accounts in the **Users** tab.

| Setting | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | `admin` | Password for the built-in `admin` login. Always set this. |
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
2. **Playlists tab**: create a playlist, click media to add it, set how many seconds each item shows, reorder with the arrows, and **Save**. Besides images and videos you can add:
   - **Text or ticker**: a typed message with your colours, shown full-size or scrolling along as a ticker.
   - **YouTube**: a video, playlist or live stream, muted or with sound. **Web page**: any web page. Both need internet on the screen.
   - **World clock**: up to 8 cities side by side, 12- or 24-hour, in your colours.
   - **News feed**: Google News headlines (pick a country, a topic or a search) or any RSS feed, as a scrolling ticker or a headline list. The CMS fetches headlines every 10 minutes and screens keep the last ones if the internet drops.
   - **Live stream**: an HLS (`.m3u8`) or direct video address. On its own in a playlist it plays nonstop.
   - Any item can have a **start / end date** so a promotion appears and disappears by itself.
3. Open the player app on the screen. Enter the CMS address, e.g. `http://192.168.1.10:3000`. The screen shows a 6-letter code.
4. **Screens tab**: type the code, give the screen a name and pick a playlist or layout, then **Pair screen**.

The screen downloads everything, then loops the playlist. When you edit a playlist or assign a different one, screens pick it up within 15–30 seconds. Screens keep playing from their saved copy if the network or CMS goes down.

### More you can do

- **Ready-made designs** (Layouts tab, "Start from a ready-made design"): News & world clock, YouTube + news ticker, Newsroom, Lobby, Welcome screen, World clock wall and News wall. Pick one, fill in the YouTube link, news and cities, choose colours, tick the screens or groups, and it's created and sent in one go. Any layout can also be sent later with **Send to screens**.
- **What each zone shows** (Layouts tab): every zone has a **Shows** picker. Choose a playlist, or put a source straight on the zone: a YouTube video or playlist, a **live TV news channel** (Al Jazeera, DW, France 24, Sky News, ABC, NBC, Euronews, CNA, TRT World, Africanews, or any YouTube channel link), **X (Twitter) posts** from an account, news headlines, a world clock, text or a ticker, or a web page. X decides what logged-out viewers see, and its embedded timelines often show nothing; prefer news headlines or a live channel if that happens.
- **Layouts tab**: split the screen into zones (e.g. main video, sidebar, ticker along the bottom), each playing its own playlist. Start from a preset and adjust. Only the biggest zone plays sound.
- **Schedule** (Screens tab): show different playlists or layouts on certain days and times, e.g. breakfast menu 06:00–11:00 on weekdays. Outside the time slots the screen shows its normal content. Times follow each screen's own clock, so set the right time zone on the device.
- **Groups** (Screens tab): put screens in a group, e.g. "All lobby TVs", and set the content and schedule once for all of them.
- **Control** (Screens tab): see a screenshot of what a screen is showing, refresh its content, restart the app, or reboot it. Rebooting only works on rooted devices; others restart the app instead.
- **Dashboard tab**: how many screens are online, which are offline and since when, and recent activity. Admins can add an **offline alert** address (a Slack, Discord, Teams or Google Chat webhook, or an [ntfy.sh](https://ntfy.sh) topic for phone notifications) that gets a message when a screen goes offline and when it comes back.
- **Users tab** (admins): add accounts as **Admin** (everything), **Editor** (content and screens, not accounts) or **Viewer** (look only). Anyone with a named account can change their own password from the button at the top right.

**On the screen**: press **Back** or **Menu** on the remote, or tap the screen five times quickly, to open the settings menu (change server, unpair, exit).

## Videos and TVs

Most TVs and TV boxes only play **H.264 video up to 1920×1080**. A 4K or H.265 (HEVC) video often shows a black screen. The Media tab shows each video's size and format:

- If [FFmpeg](https://ffmpeg.org) is installed on the CMS computer (`winget install Gyan.FFmpeg` on Windows), the CMS automatically makes a 1080p H.264 copy of any such video, and screens download that copy. Your original is kept for previews.
- Without FFmpeg, the video is marked with a warning; export a 1920×1080 H.264 version and upload that instead.

If a video still shows no picture, the player switches by itself to a compatibility way of drawing video that some TVs need, and reports any problem in the screen's live status.

## Live status and instant updates

Screens keep a connection open to the CMS, so playlist changes, schedule changes and remote commands reach them within a second or two instead of at the next check-in. Each screen reports what it's doing (what plays in each zone, downloads, errors such as "can't play 4K video", screen size, free space); you'll see it on the Screens tab, in the **Control** dialog and on the Dashboard, updating live. Live status needs player version 1.4.0 or newer.

## Kiosk tips

- The app starts automatically after a reboot. On Android 10 and newer, some devices block that; on those, set the player as the default **Home** app, or use the device's own "auto-start app" setting (common on signage boxes).
- Turn off the device's screensaver/sleep in Android settings.
- Give the CMS computer a fixed IP address on your network so screens can always find it.
- If the CMS is reachable from the internet, put it behind HTTPS (e.g. Caddy or nginx) and use an `https://` address in the app.

## Updating screens to the new player

Players on app version 1.0 keep working with this CMS, but only show images and videos fullscreen. Install the new APK over the old one to get text, web pages, streams, layouts, schedules, screenshots and remote control; the screen stays paired. If Android refuses the update (this happens when the two APKs were built on different computers, because each signs with its own debug key), uninstall the old app first and pair the screen again.
