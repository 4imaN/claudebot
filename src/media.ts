import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ImageInput {
  mediaType: "image/jpeg";
  data: string;
}

export const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR ?? "data/media");
mkdirSync(MEDIA_DIR, { recursive: true });

const MAX_IMAGE_EDGE = 1568;
const VIDEO_FRAMES = Number(process.env.VIDEO_FRAMES ?? 8);

function run(cmd: string, args: string[], timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout),
    ),
  );
}

function stamp(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function downloadTelegramFile(token: string, filePath: string, ext: string): Promise<string> {
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`Telegram file download failed (${res.status})`);
  const out = path.join(MEDIA_DIR, `${stamp()}${ext}`);
  await writeFile(out, Buffer.from(await res.arrayBuffer()));
  return out;
}

export async function toJpeg(input: string): Promise<string> {
  const out = path.join(MEDIA_DIR, `${stamp()}.jpg`);
  await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", "-Z", String(MAX_IMAGE_EDGE), input, "--out", out]);
  return out;
}

export async function imageInput(jpegPath: string): Promise<ImageInput> {
  return { mediaType: "image/jpeg", data: (await readFile(jpegPath)).toString("base64") };
}

export async function videoFrames(input: string): Promise<{ frames: string[]; duration: number }> {
  const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input]);
  const duration = Math.max(Number.parseFloat(probe.trim()) || 0, 0.1);
  const dir = path.join(MEDIA_DIR, `frames-${stamp()}`);
  mkdirSync(dir, { recursive: true });
  const fps = VIDEO_FRAMES / duration;
  await run(
    "ffmpeg",
    [
      "-loglevel", "error", "-i", input,
      "-vf", `fps=${fps},scale='min(${MAX_IMAGE_EDGE},iw)':-2`,
      "-frames:v", String(VIDEO_FRAMES), "-q:v", "4",
      path.join(dir, "frame-%02d.jpg"),
    ],
    180000,
  );
  const frames = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort().map((f) => path.join(dir, f));
  if (!frames.length) throw new Error("Couldn't extract any frames from the video.");
  return { frames, duration };
}

interface WindowInfo {
  id: number;
  owner: string;
  title: string;
  onscreen: boolean;
  area: number;
}

const LIST_WINDOWS_JXA = `
ObjC.import("CoreGraphics");
const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
const out = [];
for (let i = 0; i < list.count; i++) {
  const w = list.objectAtIndex(i);
  if (w.objectForKey("kCGWindowLayer").js !== 0) continue;
  const b = w.objectForKey("kCGWindowBounds");
  const width = b.objectForKey("Width").js, height = b.objectForKey("Height").js;
  if (width < 100 || height < 100) continue;
  const on = w.objectForKey("kCGWindowIsOnscreen");
  out.push({
    id: w.objectForKey("kCGWindowNumber").js,
    owner: w.objectForKey("kCGWindowOwnerName").js || "",
    title: (w.objectForKey("kCGWindowName") && w.objectForKey("kCGWindowName").js) || "",
    onscreen: !!(on && on.js),
    area: width * height,
  });
}
JSON.stringify(out);
`;

export async function listWindows(): Promise<WindowInfo[]> {
  return JSON.parse(await run("osascript", ["-l", "JavaScript", "-e", LIST_WINDOWS_JXA]));
}

export async function listAppNames(): Promise<string[]> {
  const names = new Set((await listWindows()).filter((w) => w.onscreen).map((w) => w.owner));
  return [...names].sort((a, b) => a.localeCompare(b));
}

function screenRecordingHint(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/could not create image/i.test(msg)) {
    return new Error(
      "macOS blocked the screenshot. Give Screen Recording permission to the app the bot was started from (System Settings → Privacy & Security → Screen & System Audio Recording), then restart the bot.",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

export async function screenshot(appQuery?: string): Promise<{ file: string; label: string }> {
  const out = path.join(MEDIA_DIR, `screenshot-${stamp()}.jpg`);
  if (!appQuery) {
    try {
      await run("screencapture", ["-x", "-t", "jpg", out]);
    } catch (err) {
      throw screenRecordingHint(err);
    }
    return { file: out, label: "Screen" };
  }

  const q = appQuery.toLowerCase();
  const matches = (await listWindows()).filter(
    (w) => w.owner.toLowerCase().includes(q) || w.title.toLowerCase().includes(q),
  );
  if (!matches.length) {
    const apps = await listAppNames().catch(() => []);
    throw new Error(`No window found for "${appQuery}".${apps.length ? ` Open apps: ${apps.join(", ")}` : ""}`);
  }
  matches.sort((a, b) => Number(b.onscreen) - Number(a.onscreen) || b.area - a.area);
  const win = matches[0];
  try {
    await run("screencapture", ["-x", "-o", "-l", String(win.id), "-t", "jpg", out]);
  } catch (err) {
    throw screenRecordingHint(err);
  }
  return { file: out, label: `${win.owner}${win.title ? ` — ${win.title}` : ""}` };
}

export async function cleanupMedia(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(MEDIA_DIR).catch(() => [] as string[])) {
    const ts = Number(name.replace(/^(screenshot-|frames-)/, "").split("-")[0]);
    if (Number.isFinite(ts) && now - ts > maxAgeMs) await rm(path.join(MEDIA_DIR, name), { recursive: true, force: true });
  }
}
