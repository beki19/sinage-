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

export interface Device {
  id: string;
  name: string;
  token: string;
  playlistId: string | null;
  pairedAt: string;
  lastSeen: string | null;
  info: Record<string, string>;
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
  devices: Device[];
  pairings: PendingPairing[];
  sessions: { token: string; createdAt: string }[];
}

const empty = (): Data => ({ media: [], playlists: [], devices: [], pairings: [], sessions: [] });

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
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
