import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import {
  COMMAND_TYPES, ROLES, Store, type CommandType, type Device, type Group, type Role, type User, type Layout, type LayoutZone, type Media, type Playlist, type PlaylistItem, type ScheduleRule,
} from "./store.js";

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

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Does [rule] cover this moment? Mirrors ScheduleRule.matches in the Android player. */
export function ruleMatches(rule: Pick<ScheduleRule, "days" | "start" | "end">, at: Date): boolean {
  const t = at.getHours() * 60 + at.getMinutes();
  const day = at.getDay();
  const start = minutes(rule.start);
  const end = minutes(rule.end);
  if (start === end) return rule.days.includes(day);
  if (start < end) return rule.days.includes(day) && t >= start && t < end;
  // Runs past midnight: the evening of a listed day, or the early hours after one.
  return (rule.days.includes(day) && t >= start) || (rule.days.includes((day + 6) % 7) && t < end);
}

/** The login that uses ADMIN_PASSWORD. No user account may take this name. */
const BUILTIN_ADMIN = "admin";

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, passwordHash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function checkPassword(user: Pick<User, "salt" | "passwordHash">, password: string): boolean {
  const actual = crypto.scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

const DUMMY_USER = hashPassword(crypto.randomBytes(16).toString("hex"));

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

/** A playlist item resolved for the player. `kind` is image | video | text | web | youtube | stream. */
interface ScreenItem {
  id: string;
  kind: string;
  duration: number;
  startAt: string | null;
  endAt: string | null;
  mediaId?: string;
  text?: string;
  color?: string;
  background?: string;
  scroll?: boolean;
  url?: string;
  videoId?: string;
}

// Express 5 forwards rejected promises to the error handler, so handlers can just throw.
type Handler = (req: Request, res: Response) => unknown;

export function createApp(opts: AppOptions) {
  const store = new Store(opts.dataDir);
  const mediaDir = path.join(opts.dataDir, "media");
  const screenshotDir = path.join(opts.dataDir, "screenshots");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(screenshotDir, { recursive: true });
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

  /** Who is logged in. The built-in "admin" login (ADMIN_PASSWORD) has no user record. */
  const currentUser = (req: Request): { id: string | null; username: string; role: Role } => {
    pruneExpired();
    // Query token lets <img>/<video> tags in the admin UI load previews.
    const token = bearer(req, "Bearer") ?? (typeof req.query.token === "string" ? req.query.token : undefined);
    const session = token ? db.sessions.find((s) => sameSecret(s.token, token)) : undefined;
    if (!session) throw new HttpError(401, "Not logged in");
    if (!session.userId) return { id: null, username: BUILTIN_ADMIN, role: "admin" };
    const user = db.users.find((u) => u.id === session.userId);
    if (!user) throw new HttpError(401, "Not logged in"); // account was deleted
    return { id: user.id, username: user.username, role: user.role };
  };

  /** Any logged-in user may look; viewers may not change anything. */
  const requireLogin = (req: Request, res: Response, next: NextFunction) => {
    const user = currentUser(req);
    if (user.role === "viewer" && req.method !== "GET" && req.method !== "HEAD") {
      throw new HttpError(403, "Your account can only view, not make changes");
    }
    res.locals.user = user;
    next();
  };

  /** Logged in with any role, even for changes (log out, change own password). */
  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    res.locals.user = currentUser(req);
    next();
  };

  const requireAdminRole = (req: Request, res: Response, next: NextFunction) => {
    const user = currentUser(req);
    if (user.role !== "admin") throw new HttpError(403, "Only admins can manage user accounts");
    res.locals.user = user;
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

  const publicDevice = (device: Device) => {
    const { token: _t, ...rest } = device;
    return {
      ...rest,
      online: rest.lastSeen ? Date.now() - Date.parse(rest.lastSeen) < 2 * 60 * 1000 : false,
      nowShowing: refName(activeRef(assignmentOf(device))),
    };
  };

  const newPassword = (v: unknown): string => {
    if (typeof v !== "string" || v.length < 8 || v.length > 200) throw new HttpError(400, "Passwords need at least 8 characters");
    return v;
  };

  const color = (v: unknown, fallback: string): string => {
    if (v == null || v === "") return fallback;
    if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new HttpError(400, "Colors must look like #1a2b3c");
    return v.toLowerCase();
  };

  const localDateTime = (v: unknown, field: string): string | null => {
    if (v == null || v === "") return null;
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) {
      throw new HttpError(400, `${field} must look like 2026-10-19T08:00`);
    }
    return v;
  };

  const httpUrl = (v: unknown, field: string): string => {
    const s = str(v, field, 2000);
    let u: URL;
    try { u = new URL(s); } catch { throw new HttpError(400, `${field} is not a valid web address`); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, `${field} must start with http:// or https://`);
    return u.toString();
  };

  const parseItems = (raw: unknown): PlaylistItem[] => {
    if (!Array.isArray(raw)) throw new HttpError(400, "items must be an array");
    return raw.map((it) => {
      const duration = Number(it?.duration ?? 10);
      if (!Number.isFinite(duration) || duration < 1 || duration > 86400) {
        throw new HttpError(400, "items[].duration must be 1-86400 seconds");
      }
      const base = {
        id: typeof it?.id === "string" ? it.id : id(),
        duration: Math.round(duration),
        startAt: localDateTime(it?.startAt, "items[].startAt"),
        endAt: localDateTime(it?.endAt, "items[].endAt"),
      };
      if (base.startAt && base.endAt && base.endAt <= base.startAt) {
        throw new HttpError(400, "An item's end date must be after its start date");
      }
      const kind = it?.kind ?? "media";
      switch (kind) {
        case "media": {
          const mediaId = str(it?.mediaId, "items[].mediaId");
          findOr404(db.media, mediaId, "Media");
          return { ...base, kind, mediaId };
        }
        case "text":
          return {
            ...base, kind,
            text: str(it?.text, "items[].text", 1000),
            color: color(it?.color, "#ffffff"),
            background: color(it?.background, "#000000"),
            scroll: Boolean(it?.scroll),
          };
        case "web":
        case "stream":
          return { ...base, kind, url: httpUrl(it?.url, "items[].url") };
        default:
          throw new HttpError(400, "items[].kind must be media, text, web or stream");
      }
    });
  };

  const parseZones = (raw: unknown): LayoutZone[] => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) throw new HttpError(400, "A layout needs 1-12 zones");
    return raw.map((z, i) => {
      const num = (v: unknown, field: string, min: number) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < min || n > 100) throw new HttpError(400, `Zone ${i + 1}: ${field} must be ${min}-100`);
        return Math.round(n * 100) / 100;
      };
      const zone = {
        id: typeof z?.id === "string" ? z.id : id(),
        name: typeof z?.name === "string" && z.name.trim() ? z.name.trim().slice(0, 60) : `Zone ${i + 1}`,
        x: num(z?.x, "x", 0), y: num(z?.y, "y", 0), w: num(z?.w, "width", 1), h: num(z?.h, "height", 1),
        playlistId: z?.playlistId ? findOr404(db.playlists, String(z.playlistId), "Playlist").id : null,
      };
      if (zone.x + zone.w > 100.01 || zone.y + zone.h > 100.01) throw new HttpError(400, `Zone ${i + 1} goes past the edge of the screen`);
      return zone;
    });
  };

  const parseSchedule = (raw: unknown): ScheduleRule[] => {
    if (!Array.isArray(raw) || raw.length > 50) throw new HttpError(400, "schedule must be a list of up to 50 time slots");
    const hhmm = (v: unknown, field: string) => {
      if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError(400, `${field} must be a time like 08:30`);
      return v;
    };
    return raw.map((r, i) => {
      const days = Array.isArray(r?.days) ? [...new Set<number>(r.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
      if (!days.length) throw new HttpError(400, `Time slot ${i + 1} needs at least one day`);
      const rule: ScheduleRule = {
        id: typeof r?.id === "string" ? r.id : id(),
        days,
        start: hhmm(r?.start, `Time slot ${i + 1} start`),
        end: hhmm(r?.end, `Time slot ${i + 1} end`),
        playlistId: null,
        layoutId: null,
      };
      applyContent(rule, r);
      if (!rule.playlistId && !rule.layoutId) throw new HttpError(400, `Time slot ${i + 1} needs a playlist or layout`);
      return rule;
    });
  };

  const applyGroup = (device: Device, body: Record<string, unknown> | undefined) => {
    if (body?.groupId !== undefined) {
      device.groupId = body.groupId ? findOr404(db.groups, String(body.groupId), "Group").id : null;
    }
  };

  /** Reads playlistId / layoutId (and schedule, where the target has one) from a request body. */
  function applyContent(target: { playlistId: string | null; layoutId: string | null; schedule?: ScheduleRule[] }, body: Record<string, unknown> | undefined) {
    if (body?.playlistId !== undefined) {
      target.playlistId = body.playlistId ? findOr404(db.playlists, String(body.playlistId), "Playlist").id : null;
    }
    if (body?.layoutId !== undefined) {
      target.layoutId = body.layoutId ? findOr404(db.layouts, String(body.layoutId), "Layout").id : null;
    }
    if (target.schedule && body?.schedule !== undefined) target.schedule = parseSchedule(body.schedule);
  }

  /** "https://youtu.be/abc" or "https://www.youtube.com/watch?v=abc" -> "abc" */
  const youtubeId = (url: string): string | null => {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, "");
    let vid: string | null = null;
    if (host === "youtu.be") vid = u.pathname.slice(1);
    else if (host === "youtube.com" || host === "youtube-nocookie.com") {
      vid = u.searchParams.get("v") ?? u.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1] ?? null;
    }
    return vid && /^[\w-]{6,20}$/.test(vid) ? vid : null;
  };

  /** One playlist as the screen sees it: every item resolved to what the player needs. */
  const screenItems = (playlist: Playlist | undefined): ScreenItem[] =>
    (playlist?.items ?? []).flatMap((it): ScreenItem[] => {
      const common = { id: it.id, duration: it.duration, startAt: it.startAt ?? null, endAt: it.endAt ?? null };
      switch (it.kind) {
        case "media": {
          const m = db.media.find((x) => x.id === it.mediaId);
          return m ? [{ ...common, kind: m.type, mediaId: m.id }] : [];
        }
        case "text":
          return [{ ...common, kind: "text", text: it.text, color: it.color, background: it.background, scroll: !!it.scroll }];
        case "web": {
          const vid = youtubeId(it.url!);
          return [vid ? { ...common, kind: "youtube", videoId: vid } : { ...common, kind: "web", url: it.url }];
        }
        case "stream":
          return [{ ...common, kind: "stream", url: it.url }];
        default:
          return [];
      }
    });

  const mediaFile = (m: Media) =>
    ({ mediaId: m.id, type: m.type, mime: m.mime, size: m.size, sha256: m.sha256, url: `/api/player/media/${m.id}` });

  const playlistById = (pid: string | null) => (pid ? db.playlists.find((p) => p.id === pid) : undefined);

  /** "layout:<id>" or "playlist:<id>" for what a screen shows, or null if nothing (or it was deleted). */
  const contentRef = (c: { playlistId: string | null; layoutId: string | null }): string | null => {
    if (c.layoutId && db.layouts.some((l) => l.id === c.layoutId)) return `layout:${c.layoutId}`;
    if (c.playlistId && playlistById(c.playlistId)) return `playlist:${c.playlistId}`;
    return null;
  };

  /** A "program" is what fills the whole screen: a list of zones, each looping its own items. */
  const programFor = (ref: string) => {
    const [kind, refId] = ref.split(":");
    if (kind === "layout") {
      const l = db.layouts.find((x) => x.id === refId)!;
      return {
        id: ref,
        name: l.name,
        zones: l.zones.map((z) => ({ id: z.id, x: z.x, y: z.y, w: z.w, h: z.h, items: screenItems(playlistById(z.playlistId)) })),
      };
    }
    const p = playlistById(refId)!;
    return { id: ref, name: p.name, zones: [{ id: "main", x: 0, y: 0, w: 100, h: 100, items: screenItems(p) }] };
  };

  /** The playlist a version-1.0 player (fullscreen images and videos only) should show for a program. */
  const legacyPlaylist = (ref: string | null): Playlist | undefined => {
    if (!ref) return undefined;
    const [kind, refId] = ref.split(":");
    if (kind === "playlist") return playlistById(refId);
    const zones = db.layouts.find((l) => l.id === refId)?.zones ?? [];
    const biggest = [...zones].sort((a, b) => b.w * b.h - a.w * a.h)[0];
    return playlistById(biggest?.playlistId ?? null);
  };

  type Assignment = { playlistId: string | null; layoutId: string | null; schedule: ScheduleRule[] };

  /** Where a screen takes its content from: its group if it has one, otherwise itself. */
  const assignmentOf = (device: Device): Assignment =>
    (device.groupId ? db.groups.find((g) => g.id === device.groupId) : undefined) ?? device;

  /** Everything that points at playlists and layouts: screens and groups. */
  const assignments = (): Assignment[] => [...db.devices, ...db.groups];

  /** Time slots whose playlist or layout still exists, pointing at program ids. */
  const scheduleRefs = (a: Assignment) => a.schedule.flatMap((r) => {
    const program = contentRef(r);
    return program ? [{ days: r.days, start: r.start, end: r.end, program }] : [];
  });

  /** What a screen should show at [at] by the server's clock. Screens decide by their own clock. */
  const activeRef = (a: Assignment, at = new Date()) =>
    scheduleRefs(a).find((r) => ruleMatches(r, at))?.program ?? contentRef(a);

  const refName = (ref: string | null) => {
    if (!ref) return null;
    const [kind, refId] = ref.split(":");
    return (kind === "layout" ? db.layouts.find((l) => l.id === refId) : playlistById(refId))?.name ?? null;
  };

  /** Commands older than this are dropped: the screen was probably off, and a stale reboot helps nobody. */
  const COMMAND_TTL_MS = 10 * 60 * 1000;

  const pendingCommands = (device: Device) => {
    device.commands = device.commands.filter((c) => Date.now() - Date.parse(c.createdAt) < COMMAND_TTL_MS);
    return device.commands;
  };

  const commandType = (raw: unknown): CommandType => {
    if (!COMMAND_TYPES.includes(raw as CommandType)) throw new HttpError(400, `Command must be one of: ${COMMAND_TYPES.join(", ")}`);
    return raw as CommandType;
  };

  const queueCommand = (device: Device, type: CommandType) => {
    // One of each kind is enough.
    if (!pendingCommands(device).some((c) => c.type === type)) device.commands.push({ id: id(), type, createdAt: now() });
  };

  const screenshotFile = (deviceId: string) => path.join(screenshotDir, `${deviceId}.jpg`);

  const manifestFor = (device: Device) => {
    const a = assignmentOf(device);
    const defaultProgram = contentRef(a);
    const schedule = scheduleRefs(a);
    const refs = [...new Set([defaultProgram, ...schedule.map((r) => r.program)])].filter((r): r is string => !!r);
    const programs = refs.map(programFor);
    const mediaIds = new Set(programs.flatMap((p) => p.zones.flatMap((z) => z.items.flatMap((i) => (i.mediaId ? [i.mediaId] : [])))));
    const media = db.media.filter((m) => mediaIds.has(m.id)).map(mediaFile);
    // Players from version 1.0 only understand `items`: images and videos of one playlist, picked by the server's clock.
    const legacyRef = activeRef(a);
    const version = crypto.createHash("sha256")
      .update(JSON.stringify([device.name, programs, defaultProgram, schedule, media, legacyRef]))
      .digest("hex").slice(0, 16);
    const playlist = legacyPlaylist(legacyRef);
    const legacyItems = (playlist?.items ?? []).flatMap((it) => {
      const m = it.kind === "media" ? db.media.find((x) => x.id === it.mediaId) : undefined;
      return m ? [{ id: it.id, ...mediaFile(m), duration: it.duration }] : [];
    });
    return {
      deviceId: device.id,
      deviceName: device.name,
      version,
      playlist: playlist ? { id: playlist.id, name: playlist.name } : null,
      items: legacyItems,
      media,
      programs,
      defaultProgram,
      schedule,
      // Not part of `version`: they don't change what's on screen.
      commands: pendingCommands(device).map(({ id: cid, type }) => ({ id: cid, type })),
      pollSeconds: 15,
    };
  };

  const route = (fn: Handler) => (req: Request, res: Response) => fn(req, res);

  // ---------- admin auth ----------

  app.post("/api/login", route((req, res) => {
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
    let userId: string | null = null;
    if (!username || username.toLowerCase() === BUILTIN_ADMIN) {
      if (!sameSecret(password, opts.adminPassword)) throw new HttpError(401, "Wrong username or password");
    } else {
      const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
      // Hash even for unknown names so response time doesn't reveal which usernames exist.
      const matches = checkPassword(user ?? DUMMY_USER, password);
      if (!user || !matches) throw new HttpError(401, "Wrong username or password");
      userId = user.id;
    }
    pruneExpired();
    const token = secret();
    db.sessions.push({ token, createdAt: now(), userId });
    store.save();
    res.json({ token });
  }));

  app.get("/api/me", requireSession, route((_req, res) => res.json(res.locals.user)));

  app.post("/api/me/password", requireSession, route((req, res) => {
    const me = res.locals.user as { id: string | null };
    if (!me.id) throw new HttpError(400, "The built-in admin password is set with ADMIN_PASSWORD when the server starts");
    const user = findOr404(db.users, me.id, "User");
    if (!checkPassword(user, typeof req.body?.current === "string" ? req.body.current : "")) {
      throw new HttpError(400, "Current password is wrong");
    }
    Object.assign(user, hashPassword(newPassword(req.body?.password)));
    store.save();
    res.status(204).end();
  }));

  // ---------- user accounts (admins only) ----------

  const publicUser = ({ passwordHash: _h, salt: _s, ...rest }: User) => rest;

  const role = (v: unknown): Role => {
    if (!ROLES.includes(v as Role)) throw new HttpError(400, `role must be one of: ${ROLES.join(", ")}`);
    return v as Role;
  };

  app.get("/api/users", requireAdminRole, route((_req, res) => res.json(db.users.map(publicUser))));

  app.post("/api/users", requireAdminRole, route((req, res) => {
    const username = str(req.body?.username, "username", 50);
    if (!/^[\w.@-]+$/.test(username)) throw new HttpError(400, "Usernames may use letters, numbers, . _ - and @");
    if (username.toLowerCase() === BUILTIN_ADMIN || db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      throw new HttpError(409, "That username is taken");
    }
    const user: User = { id: id(), username, role: role(req.body?.role ?? "editor"), ...hashPassword(newPassword(req.body?.password)), createdAt: now() };
    db.users.push(user);
    store.save();
    res.status(201).json(publicUser(user));
  }));

  app.patch("/api/users/:id", requireAdminRole, route((req, res) => {
    const user = findOr404(db.users, String(req.params.id), "User");
    if (req.body?.role !== undefined) user.role = role(req.body.role);
    if (req.body?.password !== undefined) {
      Object.assign(user, hashPassword(newPassword(req.body.password)));
      // A reset password logs the account out everywhere.
      db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    }
    store.save();
    res.json(publicUser(user));
  }));

  app.delete("/api/users/:id", requireAdminRole, route((req, res) => {
    const user = findOr404(db.users, String(req.params.id), "User");
    db.users = db.users.filter((u) => u !== user);
    db.sessions = db.sessions.filter((s) => s.userId !== user.id);
    store.save();
    res.status(204).end();
  }));

  app.post("/api/logout", requireSession, route((req, res) => {
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

  app.get("/api/media", requireLogin, route((_req, res) => {
    res.json([...db.media].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }));

  app.post("/api/media", requireLogin, upload.array("files", 50), route(async (req, res) => {
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

  app.patch("/api/media/:id", requireLogin, route((req, res) => {
    const m = findOr404(db.media, String(req.params.id), "Media");
    m.name = str(req.body?.name, "name");
    store.save();
    res.json(m);
  }));

  app.delete("/api/media/:id", requireLogin, route((req, res) => {
    const m = findOr404(db.media, String(req.params.id), "Media");
    db.media = db.media.filter((x) => x !== m);
    for (const p of db.playlists) {
      const before = p.items.length;
      p.items = p.items.filter((it) => it.kind !== "media" || it.mediaId !== m.id);
      if (p.items.length !== before) p.updatedAt = now();
    }
    fs.rmSync(path.join(mediaDir, m.filename), { force: true });
    store.save();
    res.status(204).end();
  }));

  app.get("/api/media/:id/file", requireLogin, route((req, res) => {
    const m = findOr404(db.media, String(req.params.id), "Media");
    res.type(m.mime).sendFile(path.join(mediaDir, m.filename));
  }));

  // ---------- playlists ----------

  app.get("/api/playlists", requireLogin, route((_req, res) => res.json(db.playlists)));

  app.post("/api/playlists", requireLogin, route((req, res) => {
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

  app.put("/api/playlists/:id", requireLogin, route((req, res) => {
    const p = findOr404(db.playlists, String(req.params.id), "Playlist");
    if (req.body?.name !== undefined) p.name = str(req.body.name, "name");
    if (req.body?.items !== undefined) p.items = parseItems(req.body.items);
    p.updatedAt = now();
    store.save();
    res.json(p);
  }));

  app.delete("/api/playlists/:id", requireLogin, route((req, res) => {
    const p = findOr404(db.playlists, String(req.params.id), "Playlist");
    db.playlists = db.playlists.filter((x) => x !== p);
    for (const a of assignments()) {
      if (a.playlistId === p.id) a.playlistId = null;
      a.schedule = a.schedule.filter((r) => r.playlistId !== p.id);
    }
    for (const l of db.layouts) for (const z of l.zones) if (z.playlistId === p.id) z.playlistId = null;
    store.save();
    res.status(204).end();
  }));

  // ---------- layouts ----------

  app.get("/api/layouts", requireLogin, route((_req, res) => res.json(db.layouts)));

  app.post("/api/layouts", requireLogin, route((req, res) => {
    const l: Layout = {
      id: id(),
      name: str(req.body?.name, "name"),
      zones: req.body?.zones
        ? parseZones(req.body.zones)
        : [{ id: id(), name: "Main", x: 0, y: 0, w: 100, h: 100, playlistId: null }],
      updatedAt: now(),
    };
    db.layouts.push(l);
    store.save();
    res.status(201).json(l);
  }));

  app.put("/api/layouts/:id", requireLogin, route((req, res) => {
    const l = findOr404(db.layouts, String(req.params.id), "Layout");
    if (req.body?.name !== undefined) l.name = str(req.body.name, "name");
    if (req.body?.zones !== undefined) l.zones = parseZones(req.body.zones);
    l.updatedAt = now();
    store.save();
    res.json(l);
  }));

  app.delete("/api/layouts/:id", requireLogin, route((req, res) => {
    const l = findOr404(db.layouts, String(req.params.id), "Layout");
    db.layouts = db.layouts.filter((x) => x !== l);
    for (const a of assignments()) {
      if (a.layoutId === l.id) a.layoutId = null;
      a.schedule = a.schedule.filter((r) => r.layoutId !== l.id);
    }
    store.save();
    res.status(204).end();
  }));

  // ---------- screen groups ----------

  app.get("/api/groups", requireLogin, route((_req, res) => res.json(db.groups)));

  app.post("/api/groups", requireLogin, route((req, res) => {
    const g: Group = { id: id(), name: str(req.body?.name, "name"), playlistId: null, layoutId: null, schedule: [], createdAt: now() };
    applyContent(g, req.body);
    db.groups.push(g);
    store.save();
    res.status(201).json(g);
  }));

  app.patch("/api/groups/:id", requireLogin, route((req, res) => {
    const g = findOr404(db.groups, String(req.params.id), "Group");
    if (req.body?.name !== undefined) g.name = str(req.body.name, "name");
    applyContent(g, req.body);
    store.save();
    res.json(g);
  }));

  app.delete("/api/groups/:id", requireLogin, route((req, res) => {
    const g = findOr404(db.groups, String(req.params.id), "Group");
    db.groups = db.groups.filter((x) => x !== g);
    // Screens leave the group and go back to their own content.
    for (const d of db.devices) if (d.groupId === g.id) d.groupId = null;
    store.save();
    res.status(204).end();
  }));

  // ---------- devices (admin side) ----------

  app.get("/api/devices", requireLogin, route((_req, res) => {
    res.json(db.devices.map(publicDevice));
  }));

  app.post("/api/devices/pair", requireLogin, route((req, res) => {
    pruneExpired();
    const code = str(req.body?.code, "code", 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
    const pairing = db.pairings.find((p) => p.code === code && !p.deviceId);
    if (!pairing) throw new HttpError(404, "No screen is showing that code (codes expire after 15 minutes)");
    const device: Device = {
      id: id(),
      name: str(req.body?.name, "name"),
      token: secret(),
      playlistId: null,
      layoutId: null,
      schedule: [],
      groupId: null,
      commands: [],
      lastCommandResult: null,
      screenshotAt: null,
      pairedAt: now(),
      lastSeen: null,
      info: pairing.info,
    };
    applyContent(device, req.body);
    applyGroup(device, req.body);
    db.devices.push(device);
    pairing.deviceId = device.id;
    store.save();
    res.status(201).json(publicDevice(device));
  }));

  app.patch("/api/devices/:id", requireLogin, route((req, res) => {
    const d = findOr404(db.devices, String(req.params.id), "Device");
    if (req.body?.name !== undefined) d.name = str(req.body.name, "name");
    applyContent(d, req.body);
    applyGroup(d, req.body);
    store.save();
    res.json(publicDevice(d));
  }));

  app.delete("/api/devices/:id", requireLogin, route((req, res) => {
    const d = findOr404(db.devices, String(req.params.id), "Device");
    db.devices = db.devices.filter((x) => x !== d);
    fs.rmSync(screenshotFile(d.id), { force: true });
    store.save();
    res.status(204).end();
  }));

  app.post("/api/devices/:id/commands", requireLogin, route((req, res) => {
    const d = findOr404(db.devices, String(req.params.id), "Device");
    queueCommand(d, commandType(req.body?.type));
    store.save();
    res.status(202).json(publicDevice(d));
  }));

  app.post("/api/groups/:id/commands", requireLogin, route((req, res) => {
    const g = findOr404(db.groups, String(req.params.id), "Group");
    const type = commandType(req.body?.type);
    const members = db.devices.filter((d) => d.groupId === g.id);
    for (const d of members) queueCommand(d, type);
    store.save();
    res.status(202).json({ screens: members.length });
  }));

  app.get("/api/devices/:id/screenshot", requireLogin, route((req, res) => {
    const d = findOr404(db.devices, String(req.params.id), "Device");
    if (!d.screenshotAt || !fs.existsSync(screenshotFile(d.id))) throw new HttpError(404, "No screenshot yet");
    res.set("cache-control", "no-store").type("image/jpeg").sendFile(screenshotFile(d.id));
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
    store.saveSoon();
    res.json(manifestFor(device));
  }));

  /** The screen reports how a command went. It may report twice (e.g. "rebooting", then "couldn't"). */
  app.post("/api/player/commands/:id/done", requireDevice, route((req, res) => {
    const device = res.locals.device as Device;
    const cid = String(req.params.id);
    const cmd = device.commands.find((c) => c.id === cid);
    const type = cmd?.type ?? device.lastCommandResult?.type;
    device.commands = device.commands.filter((c) => c.id !== cid);
    if (type) {
      device.lastCommandResult = {
        type,
        ok: req.body?.ok !== false,
        message: typeof req.body?.message === "string" ? req.body.message.slice(0, 300) : "",
        at: now(),
      };
    }
    store.save();
    res.status(204).end();
  }));

  app.post("/api/player/screenshot", requireDevice, express.raw({ type: ["image/jpeg", "image/png"], limit: "10mb" }), route((req, res) => {
    const device = res.locals.device as Device;
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, "Send a JPEG image");
    fs.writeFileSync(screenshotFile(device.id), req.body);
    device.screenshotAt = now();
    device.commands = device.commands.filter((c) => c.type !== "screenshot");
    store.save();
    res.status(204).end();
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
