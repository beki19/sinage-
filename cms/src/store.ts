import fs from "node:fs";
import path from "node:path";

export type MediaType = "image" | "video";

export interface Media {
  id: string;
  name: string;
  type: MediaType;
  mime: string;
  filename: string;
  size: number;
  sha256: string;
  createdAt: string;
}

/**
 * media:  an uploaded image or video
 * text:   a typed message, shown full-zone or scrolling as a ticker
 * web:    a web page or a YouTube link
 * stream: a live video stream (HLS .m3u8 or a plain video URL)
 */
export type ItemKind = "media" | "text" | "web" | "stream";

export interface PlaylistItem {
  id: string;
  kind: ItemKind;
  /** Seconds on screen. Videos play to the end and ignore this. */
  duration: number;
  /** Optional window the item is shown in, as local date-times ("2026-10-19T08:00") on each screen's own clock. */
  startAt?: string | null;
  endAt?: string | null;
  /** kind = media */
  mediaId?: string;
  /** kind = text */
  text?: string;
  color?: string;
  background?: string;
  scroll?: boolean;
  /** kind = web | stream */
  url?: string;
}

export interface Playlist {
  id: string;
  name: string;
  items: PlaylistItem[];
  updatedAt: string;
}

/** A screen split into zones, each looping its own playlist. Positions are percent of the screen. */
export interface LayoutZone {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  playlistId: string | null;
}

export interface Layout {
  id: string;
  name: string;
  zones: LayoutZone[];
  updatedAt: string;
}

/**
 * Shows a playlist or layout on some days between two times (24h "HH:MM", on the screen's own clock).
 * An end at or before the start runs past midnight; equal start and end means all day.
 */
export interface ScheduleRule {
  id: string;
  /** 0 = Sunday ... 6 = Saturday */
  days: number[];
  start: string;
  end: string;
  playlistId: string | null;
  layoutId: string | null;
}

export interface Device {
  id: string;
  name: string;
  token: string;
  /** What the screen shows by default: a layout if set, otherwise a fullscreen playlist. */
  playlistId: string | null;
  layoutId: string | null;
  /** Time slots that override the default. The first matching one wins. */
  schedule: ScheduleRule[];
  /** When set, the screen shows its group's content and schedule instead of its own. */
  groupId: string | null;
  /** Waiting for the screen to pick up on its next check-in. */
  commands: DeviceCommand[];
  lastCommandResult: { type: CommandType; ok: boolean; message: string; at: string } | null;
  /** When the latest screenshot (data/screenshots/<id>.jpg) arrived. */
  screenshotAt: string | null;
  pairedAt: string;
  lastSeen: string | null;
  info: Record<string, string>;
}

/**
 * refresh:    re-check content and restart playback from the top
 * restart:    restart the player app
 * reboot:     reboot the device (needs a rooted device; otherwise the app restarts instead)
 * screenshot: send a picture of what's on screen
 */
export const COMMAND_TYPES = ["refresh", "restart", "reboot", "screenshot"] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export interface DeviceCommand {
  id: string;
  type: CommandType;
  createdAt: string;
}

/** Screens that all show the same thing, e.g. "All lobby TVs". */
export interface Group {
  id: string;
  name: string;
  playlistId: string | null;
  layoutId: string | null;
  schedule: ScheduleRule[];
  createdAt: string;
}

/**
 * admin:  everything, including user accounts
 * editor: media, playlists, layouts, screens and groups
 * viewer: can look but not change anything
 */
export const ROLES = ["admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export interface User {
  id: string;
  username: string;
  role: Role;
  /** scrypt hash of the password, hex */
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export interface Session {
  token: string;
  createdAt: string;
  /** null for the built-in "admin" login that uses ADMIN_PASSWORD. */
  userId?: string | null;
}

export interface PendingPairing {
  code: string;
  pollToken: string;
  createdAt: string;
  info: Record<string, string>;
  /** Set once an admin claims the code; the player picks it up on its next poll. */
  deviceId?: string;
}

export interface Data {
  media: Media[];
  playlists: Playlist[];
  layouts: Layout[];
  devices: Device[];
  groups: Group[];
  pairings: PendingPairing[];
  users: User[];
  sessions: Session[];
}

const empty = (): Data => ({ media: [], playlists: [], layouts: [], devices: [], groups: [], pairings: [], users: [], sessions: [] });

/** Small JSON-file database. Fine for hundreds of screens; swap for SQL beyond that. */
export class Store {
  data: Data;
  private file: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "db.json");
    this.data = fs.existsSync(this.file)
      ? { ...empty(), ...JSON.parse(fs.readFileSync(this.file, "utf8")) }
      : empty();
    // Fill in fields added after a db.json was first written.
    for (const p of this.data.playlists) for (const it of p.items) it.kind ??= "media";
    for (const d of this.data.devices) {
      d.layoutId ??= null;
      d.schedule ??= [];
      d.groupId ??= null;
      d.commands ??= [];
      d.lastCommandResult ??= null;
      d.screenshotAt ??= null;
    }
  }

  private timer: NodeJS.Timeout | null = null;

  /** Saves within a couple of seconds, so frequent check-ins from many screens share one write. */
  saveSoon() {
    this.timer ??= setTimeout(() => this.save(), 2000).unref();
  }

  save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
