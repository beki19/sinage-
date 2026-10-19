import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VideoInfo } from "./store.js";

const CODEC_NAMES: Record<string, string> = {
  avc1: "H.264", avc3: "H.264", hvc1: "H.265", hev1: "H.265", av01: "AV1", vp09: "VP9", vp08: "VP8", mp4v: "MPEG-4",
};
const AVC_PROFILES: Record<number, string> = { 66: "Baseline", 77: "Main", 88: "Extended", 100: "High", 110: "High 10", 122: "High 4:2:2", 244: "High 4:4:4" };

/** Reads the top-level box list of an MP4/MOV file and returns the moov box, wherever it is in the file. */
function readMoov(file: string): Buffer | null {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= size) {
      fs.readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString("latin1", 4, 8);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      else if (len === 0) len = size - pos;
      if (len < 8) return null;
      if (type === "moov") {
        if (len > 64 * 1024 * 1024) return null;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, pos);
        return buf;
      }
      pos += len;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Resolution and codec of the first video track in an MP4/MOV, or null if it can't be read. */
export function probeVideo(file: string): VideoInfo | null {
  let moov: Buffer | null;
  try {
    moov = readMoov(file);
  } catch {
    return null;
  }
  if (!moov) return null;
  for (const codec of Object.keys(CODEC_NAMES)) {
    // A visual sample entry: [size][fourcc][6 reserved][2 index][16 pre-defined][width][height]…
    let i = moov.indexOf(codec, 0, "latin1");
    while (i >= 4) {
      const width = moov.readUInt16BE(i + 28);
      const height = moov.readUInt16BE(i + 30);
      if (width >= 16 && height >= 16 && width <= 16384 && height <= 16384) {
        let label = CODEC_NAMES[codec];
        let profileOk = true;
        if (codec === "avc1" || codec === "avc3") {
          const c = moov.indexOf("avcC", i, "latin1");
          if (c > 0) {
            const profile = moov[c + 5];
            const level = moov[c + 7] / 10;
            label += ` ${AVC_PROFILES[profile] ?? `profile ${profile}`} ${level}`;
            profileOk = profile === 66 || profile === 77 || profile === 100;
          }
        }
        const tvSafe = CODEC_NAMES[codec] === "H.264" && profileOk && width * height <= 1920 * 1088;
        return { width, height, codec, label: `${label}, ${width}×${height}`, tvSafe };
      }
      i = moov.indexOf(codec, i + 4, "latin1");
    }
  }
  return null;
}

let ffmpegPath: string | null = null;

/** The ffmpeg program to use, if one is installed (FFMPEG_PATH, or ffmpeg on the PATH). */
export function findFfmpeg(): string | null {
  // Only a found path is remembered, so installing FFmpeg later works without a restart.
  if (ffmpegPath) return ffmpegPath;
  const candidates = [process.env.FFMPEG_PATH, "ffmpeg", ...wingetFfmpeg()].filter((x): x is string => !!x);
  ffmpegPath = candidates.find((c) => spawnSync(c, ["-version"], { stdio: "ignore", windowsHide: true }).status === 0) ?? null;
  return ffmpegPath;
}

/** winget puts FFmpeg under %LOCALAPPDATA%\Microsoft\WinGet\Packages, which a running server's PATH won't include yet. */
function wingetFfmpeg(): string[] {
  const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Packages") : "";
  if (!root || !fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const pkg of fs.readdirSync(root).filter((d) => /ffmpeg/i.test(d))) {
    const base = path.join(root, pkg);
    for (const sub of fs.readdirSync(base)) {
      const exe = path.join(base, sub, "bin", "ffmpeg.exe");
      if (fs.existsSync(exe)) found.push(exe);
    }
  }
  return found;
}

/** Makes a 1080p (or smaller) H.264/AAC MP4 that practically every TV can play. */
export function convertForScreens(ffmpeg: string, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y", "-hide_banner", "-loglevel", "error", "-i", input,
      // Fit inside 1920×1080 without upscaling; even sizes keep encoders happy.
      "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-c:v", "libx264", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "21",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", output,
    ];
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `ffmpeg exited with ${code}`))));
  });
}
