import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { Store, type Device, type Media, type Playlist, type PlaylistItem } from "./store.js";

export interface AppOptions {
  dataDir: string;
  adminPassword: string;
  maxUploadMb?: number;
}

const PAIRING_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// No 0/O/1/I so codes are easy to read off a TV across the room.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const id = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(32).toString("base64url");
const now = () => new Date().toISOString();

function pairingCode(): string {
  let code = "";
  for (const b of crypto.randomBytes(6)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Express 5 forwards rejected promises to the error handler, so handlers can just throw.
type Handler = (req: Request, res: Response) => unknown;

export function createApp(opts: AppOptions) {
  const store = new Store(opts.dataDir);
  const mediaDir = path.join(opts.dataDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  const db = store.data;

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // ---------- helpers ----------

  const pruneExpired = () => {
    const t = Date.now();
    db.pairings = db.pairings.filter((p) => t - Date.parse(p.createdAt) < PAIRING_TTL_MS);
    db.sessions = db.sessions.filter((s) => t - Date.parse(s.createdAt) < SESSION_TTL_MS);
  };

  const bearer = (req: Request, scheme: string): string | undefined => {
    const h = req.header("authorization") ?? "";
    const [s, token] = h.split(" ");
    if (s?.toLowerCase() === scheme.toLowerCase() && token) return token;
    return undefined;
  };

  const requireAdmin = (req: Request, _res: Response, next: NextFunction) => {
    pruneExpired();
    // Query token lets <img>/<video> tags in the admin UI load previews.
    const token = bearer(req, "Bearer") ?? (typeof req.query.token === "string" ? req.query.token : undefined);
    if (!token || !db.sessions.some((s) => sameSecret(s.token, token))) {
      throw new HttpError(401, "Not logged in");
    }
    next();
  };

  const requireDevice = (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req, "Device");
    const device = token ? db.devices.find((d) => sameSecret(d.token, token)) : undefined;
    if (!device) throw new HttpError(401, "Device not paired");
    res.locals.device = device;
    next();
  };

  const findOr404 = <T extends { id: string }>(list: T[], itemId: string, what: string): T => {
    const found = list.find((x) => x.id === itemId);
    if (!found) throw new HttpError(404, `${what} not found`);
    return found;
  };

  const str = (v: unknown, field: string, max = 200): string => {
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${field} is required`);
    return v.trim().slice(0, max);
  };

  const publicDevice = ({ token: _t, ...rest }: Device) => ({
    ...rest,
    online: rest.lastSeen ? Date.now() - Date.parse(rest.lastSeen) < 2 * 60 * 1000 : false,
  });

  const parseItems = (raw: unknown): PlaylistItem[] => {
    if (!Array.isArray(raw)) throw new HttpError(400, "items must be an array");
    return raw.map((it) => {
      const mediaId = str(it?.mediaId, "items[].mediaId");
      findOr404(db.media, mediaId, "Media");
      const duration = Number(it?.duration ?? 10);
      if (!Number.isFinite(duration) || duration < 1 || duration > 86400) {
        throw new HttpError(400, "items[].duration must be 1-86400 seconds");
      }
      return { id: typeof it?.id === "string" ? it.id : id(), mediaId, duration: Math.round(duration) };
    });
  };

  const manifestFor = (device: Device) => {
    const playlist = device.playlistId ? db.playlists.find((p) => p.id === device.playlistId) : undefined;
    const items = (playlist?.items ?? []).flatMap((it) => {
      const m = db.media.find((x) => x.id === it.mediaId);
      if (!m) return [];
      return [{
        id: it.id,
        mediaId: m.id,
        type: m.type,
        mime: m.mime,
        size: m.size,
        sha256: m.sha256,
        duration: it.duration,
        url: `/api/player/media/${m.id}`,
      }];
    });
    const version = crypto.createHash("sha256")
      .update(JSON.stringify([device.name, playlist?.id, items]))
      .digest("hex").slice(0, 16);
    return {
      deviceId: device.id,
      deviceName: device.name,
      version,
      playlist: playlist ? { id: playlist.id, name: playlist.name } : null,
      items,
      pollSeconds: 30,
    };
  };

  const route = (fn: Handler) => (req: Request, res: Response) => fn(req, res);

  // ---------- admin auth ----------

  app.post("/api/login", route((req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!sameSecret(password, opts.adminPassword)) throw new HttpError(401, "Wrong password");
    pruneExpired();
    const token = secret();
    db.sessions.push({ token, createdAt: now() });
    store.save();
    res.json({ token });
  }));

  app.post("/api/logout", requireAdmin, route((req, res) => {
    const token = bearer(req, "Bearer");
    db.sessions = db.sessions.filter((s) => s.token !== token);
    store.save();
    res.status(204).end();
  }));

  // ---------- media ----------

  const upload = multer({
    storage: multer.diskStorage({
      destination: mediaDir,
      filename: (_req, file, cb) => cb(null, id() + path.extname(file.originalname).toLowerCase().slice(0, 10)),
    }),
    limits: { fileSize: (opts.maxUploadMb ?? 2048) * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      cb(null, file.mimetype.startsWith("image/") || file.mimetype.startsWith("video/"));
    },
  });

  app.get("/api/media", requireAdmin, route((_req, res) => {
    res.json([...db.media].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }));

  app.post("/api/media", requireAdmin, upload.array("files", 50), route(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw new HttpError(400, "No image or video files received");
    const created: Media[] = [];
    for (const f of files) {
      const m: Media = {
        id: path.parse(f.filename).name,
        name: f.originalname,
        type: f.mimetype.startsWith("video/") ? "video" : "image",
        mime: f.mimetype,
        filename: f.filename,
        size: f.size,
        sha256: await sha256File(f.path),
        createdAt: now(),
      };
      db.media.push(m);
      created.push(m);
    }
    store.save();
    res.status(201).json(created);
  }));

  app.patch("/api/media/:id", requireAdmin, route((req, res) => {
    const m = findOr404(db.media, String(req.params.id), "Media");
    m.name = str(req.body?.name, "name");
    store.save();
    res.json(m);
  }));

  app.delete("/api/media/:id", requireAdmin, route((req, res) => {
    const m = findOr404(db.media, String(req.params.id), "Media");
    db.media = db.media.filter((x) => x !== m);
    for (const p of db.playlists) {
      const before = p.items.length;
      p.items = p.items.filter((it) => it.mediaId !== m.id);
      if (p.items.length !== before) p.updatedAt = now();
    }
    fs.rmSync(path.join(mediaDir, m.filename), { force: true });
    store.save();
    res.status(204).end();
  }));

  app.get("/api/media/:id/file", requireAdmin, route((req, res) => {
    const m = findOr404(db.media, String(req.params.id), "Media");
    res.type(m.mime).sendFile(path.join(mediaDir, m.filename));
  }));

  // ---------- playlists ----------

  app.get("/api/playlists", requireAdmin, route((_req, res) => res.json(db.playlists)));

  app.post("/api/playlists", requireAdmin, route((req, res) => {
    const p: Playlist = {
      id: id(),
      name: str(req.body?.name, "name"),
      items: req.body?.items ? parseItems(req.body.items) : [],
      updatedAt: now(),
    };
    db.playlists.push(p);
    store.save();
    res.status(201).json(p);
  }));

  app.put("/api/playlists/:id", requireAdmin, route((req, res) => {
    const p = findOr404(db.playlists, String(req.params.id), "Playlist");
    if (req.body?.name !== undefined) p.name = str(req.body.name, "name");
    if (req.body?.items !== undefined) p.items = parseItems(req.body.items);
    p.updatedAt = now();
    store.save();
    res.json(p);
  }));

  app.delete("/api/playlists/:id", requireAdmin, route((req, res) => {
    const p = findOr404(db.playlists, String(req.params.id), "Playlist");
    db.playlists = db.playlists.filter((x) => x !== p);
    for (const d of db.devices) if (d.playlistId === p.id) d.playlistId = null;
    store.save();
    res.status(204).end();
  }));

  // ---------- devices (admin side) ----------

  app.get("/api/devices", requireAdmin, route((_req, res) => {
    res.json(db.devices.map(publicDevice));
  }));

  app.post("/api/devices/pair", requireAdmin, route((req, res) => {
    pruneExpired();
    const code = str(req.body?.code, "code", 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const pairing = db.pairings.find((p) => p.code === code && !p.deviceId);
    if (!pairing) throw new HttpError(404, "No screen is showing that code (codes expire after 15 minutes)");
    const playlistId = req.body?.playlistId ? findOr404(db.playlists, String(req.body.playlistId), "Playlist").id : null;
    const device: Device = {
      id: id(),
      name: str(req.body?.name, "name"),
      token: secret(),
      playlistId,
      pairedAt: now(),
      lastSeen: null,
      info: pairing.info,
    };
    db.devices.push(device);
    pairing.deviceId = device.id;
    store.save();
    res.status(201).json(publicDevice(device));
  }));

  app.patch("/api/devices/:id", requireAdmin, route((req, res) => {
    const d = findOr404(db.devices, String(req.params.id), "Device");
    if (req.body?.name !== undefined) d.name = str(req.body.name, "name");
    if (req.body?.playlistId !== undefined) {
      d.playlistId = req.body.playlistId ? findOr404(db.playlists, String(req.body.playlistId), "Playlist").id : null;
    }
    store.save();
    res.json(publicDevice(d));
  }));

  app.delete("/api/devices/:id", requireAdmin, route((req, res) => {
    const d = findOr404(db.devices, String(req.params.id), "Device");
    db.devices = db.devices.filter((x) => x !== d);
    store.save();
    res.status(204).end();
  }));

  // ---------- player API ----------

  app.post("/api/player/register", route((req, res) => {
    pruneExpired();
    const info: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body?.info ?? {})) {
      if (typeof v === "string" && Object.keys(info).length < 20) info[k.slice(0, 50)] = v.slice(0, 200);
    }
    let code = pairingCode();
    while (db.pairings.some((p) => p.code === code)) code = pairingCode();
    const pairing = { code, pollToken: secret(), createdAt: now(), info };
    db.pairings.push(pairing);
    store.save();
    res.status(201).json({ code, pollToken: pairing.pollToken, expiresInSeconds: PAIRING_TTL_MS / 1000 });
  }));

  app.get("/api/player/pair-status", route((req, res) => {
    pruneExpired();
    const pollToken = String(req.query.pollToken ?? "");
    const pairing = db.pairings.find((p) => sameSecret(p.pollToken, pollToken));
    if (!pairing) throw new HttpError(404, "Pairing code expired");
    const device = pairing.deviceId ? db.devices.find((d) => d.id === pairing.deviceId) : undefined;
    if (!device && pairing.deviceId) {
      // Claimed, then removed before the screen picked it up.
      db.pairings = db.pairings.filter((p) => p !== pairing);
      store.save();
      throw new HttpError(404, "Pairing code expired");
    }
    if (!device) return res.json({ status: "pending", code: pairing.code });
    // Hand the token out exactly once.
    db.pairings = db.pairings.filter((p) => p !== pairing);
    store.save();
    res.json({ status: "paired", deviceId: device.id, deviceName: device.name, deviceToken: device.token });
  }));

  app.get("/api/player/manifest", requireDevice, route((req, res) => {
    const device = res.locals.device as Device;
    device.lastSeen = now();
    const appVersion = req.header("x-player-version");
    if (appVersion) device.info.appVersion = appVersion.slice(0, 50);
    store.save();
    res.json(manifestFor(device));
  }));

  app.get("/api/player/media/:id", requireDevice, route((req, res) => {
    const m = findOr404(db.media, String(req.params.id), "Media");
    res.type(m.mime).sendFile(path.join(mediaDir, m.filename));
  }));

  // ---------- admin UI + errors ----------

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  app.use(express.static(publicDir));

  app.use("/api", (_req: Request, _res: Response) => {
    throw new HttpError(404, "Not found");
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return { app, store };
}
