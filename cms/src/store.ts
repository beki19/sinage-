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

export interface PlaylistItem {
  id: string;
  mediaId: string;
  /** Seconds to show an image. Videos play to the end and ignore this. */
  duration: number;
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
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
