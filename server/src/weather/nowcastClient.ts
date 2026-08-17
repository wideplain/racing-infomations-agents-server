import { inflateSync } from "node:zlib";
import { TtlCache } from "./cache.js";
import type { RainNowcastTimeline } from "./types.js";

const TARGET_TIMES_URL = "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json";
const FORECAST_TARGET_TIMES_URL = "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json";
const TILE_ZOOM = 10;
const TILE_SIZE = 256;

export interface NowcastTime {
  basetime: string;
  validtime: string;
}

export interface TileCoordinate {
  x: number;
  y: number;
  pixelX: number;
  pixelY: number;
}

/** Converts WGS84 coordinates to the tile and pixel used by a Slippy/Web-Mercator tile. */
export function toTileCoordinate(latitude: number, longitude: number, zoom = TILE_ZOOM): TileCoordinate {
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const lng = Math.max(-180, Math.min(180, longitude));
  const n = 2 ** zoom;
  const worldX = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const worldY = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n;
  const x = Math.min(n - 1, Math.max(0, Math.floor(worldX)));
  const y = Math.min(n - 1, Math.max(0, Math.floor(worldY)));
  return {
    x,
    y,
    pixelX: Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((worldX - x) * TILE_SIZE))),
    pixelY: Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((worldY - y) * TILE_SIZE))),
  };
}

/** Small PNG alpha reader for JMA's overlay tiles. It intentionally only returns whether the
 * target pixel is transparent; no colour-to-mm/h conversion is guessed. */
export function isPngPixelOpaque(png: Uint8Array, pixelX: number, pixelY: number): boolean | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 8 || signature.some((v, i) => png[i] !== v)) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  while (offset + 12 <= png.length) {
    const length = new DataView(png.buffer, png.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > png.length) return null;
    const data = png.subarray(start, end);
    if (type === "IHDR") {
      if (data.length !== 13) return null;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = view.getUint32(0);
      height = view.getUint32(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return null;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (!width || !height || pixelX < 0 || pixelY < 0 || pixelX >= width || pixelY >= height) return null;
  if (!idat.length) return null;
  const samplesPerPixel = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0;
  if (!samplesPerPixel) return null;
  // JMA serves the observation tile as 8-bit RGBA but the forecast tiles as sub-byte indexed
  // colour, so every palette bit depth PNG permits has to be read, not only 8.
  if (colorType === 3 ? ![1, 2, 4, 8].includes(bitDepth) : bitDepth !== 8) return null;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat.map((chunk) => Buffer.from(chunk))));
  } catch {
    return null;
  }
  const bitsPerPixel = samplesPerPixel * bitDepth;
  // Filtering always works on whole bytes; anything under one byte per pixel filters with 1.
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * height) return null;
  const rows = new Uint8Array(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)];
    const source = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1));
    const dest = rows.subarray(row * stride, (row + 1) * stride);
    const prev = row === 0 ? undefined : rows.subarray((row - 1) * stride, row * stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? dest[i - bytesPerPixel] : 0;
      const above = prev?.[i] ?? 0;
      const upperLeft = i >= bytesPerPixel ? (prev?.[i - bytesPerPixel] ?? 0) : 0;
      if (filter === 0) dest[i] = source[i];
      else if (filter === 1) dest[i] = (source[i] + left) & 255;
      else if (filter === 2) dest[i] = (source[i] + above) & 255;
      else if (filter === 3) dest[i] = (source[i] + Math.floor((left + above) / 2)) & 255;
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - upperLeft);
        dest[i] = (source[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 255;
      } else return null;
    }
  }
  if (colorType === 3) {
    const bitOffset = pixelX * bitDepth;
    const paletteIndex = (rows[pixelY * stride + (bitOffset >> 3)] >> (8 - bitDepth - (bitOffset & 7))) & ((1 << bitDepth) - 1);
    if (!palette || paletteIndex * 3 + 2 >= palette.length) return null;
    return (transparency?.[paletteIndex] ?? 255) !== 0;
  }
  const index = pixelY * stride + pixelX * samplesPerPixel;
  if (colorType === 6) return rows[index + 3] !== 0;
  return true; // RGB has no alpha channel.
}

/** The nowcast target times are UTC, despite JMA publishing everything else about these products
 * in JST. Reading them as JST put every observation and forecast nine hours in the past, which
 * showed up as a rain timeline whose every step was already "まもなく". */
function jmaTimeToIso(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).toISOString();
}

export class JmaNowcastClient {
  private fetchFn: typeof fetch;
  private timeoutMs: number;
  private targetCache = new TtlCache<NowcastTime | null>();
  private forecastTargetCache = new TtlCache<NowcastTime[] | null>();
  private tileCache = new TtlCache<boolean | null>();

  constructor(opts: { fetchFn?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async getRain(latitude: number, longitude: number): Promise<{ isRaining: boolean | null; observedAt: string | null }> {
    try {
      const target = await this.getTargetTime();
      if (!target) return { isRaining: null, observedAt: null };
      const coordinate = toTileCoordinate(latitude, longitude);
      const opaque = await this.getTileRain(target, coordinate);
      return { isRaining: opaque, observedAt: jmaTimeToIso(target.validtime) };
    } catch {
      return { isRaining: null, observedAt: null };
    }
  }

  /** JMA's N2 list is the forecast counterpart to N1: five-minute rain predictions from the
   * latest basetime through +60 minutes.  The browser asks for this only while its weather tab
   * is open; tile responses are reused until JMA changes the basetime. */
  async getRainTimeline(latitude: number, longitude: number): Promise<RainNowcastTimeline | null> {
    try {
      const targets = await this.getForecastTargetTimes();
      if (!targets?.length) return null;
      const coordinate = toTileCoordinate(latitude, longitude);
      const sorted = [...targets].sort((a, b) => a.validtime.localeCompare(b.validtime));
      const points = await Promise.all(sorted.map(async (target) => ({
        validAt: jmaTimeToIso(target.validtime) ?? target.validtime,
        isRaining: await this.getTileRain(target, coordinate),
      })));
      return { baseTime: jmaTimeToIso(sorted[0].basetime) ?? sorted[0].basetime, points };
    } catch {
      return null;
    }
  }

  private async getTileRain(target: NowcastTime, coordinate: TileCoordinate): Promise<boolean | null> {
    const key = `${target.basetime}:${target.validtime}:${coordinate.x}:${coordinate.y}`;
    let opaque = this.tileCache.get(key);
    if (opaque !== undefined) return opaque;
    const url = `https://www.jma.go.jp/bosai/jmatile/data/nowc/${target.basetime}/none/${target.validtime}/surf/hrpns/${TILE_ZOOM}/${coordinate.x}/${coordinate.y}.png`;
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) opaque = null;
    else opaque = isPngPixelOpaque(new Uint8Array(await response.arrayBuffer()), coordinate.pixelX, coordinate.pixelY);
    // The basetime is part of the key: the same tile is never fetched again while target time is unchanged.
    this.tileCache.set(key, opaque, 30 * 60 * 1000);
    return opaque;
  }

  private async getTargetTime(): Promise<NowcastTime | null> {
    const cached = this.targetCache.get("latest");
    if (cached !== undefined) return cached;
    try {
      const response = await this.fetchFn(TARGET_TIMES_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) return null;
      const list = (await response.json()) as Array<{ basetime?: string; validtime?: string }>;
      const latest = list[0];
      const target = latest?.basetime && latest.validtime ? { basetime: latest.basetime, validtime: latest.validtime } : null;
      this.targetCache.set("latest", target, 60_000);
      return target;
    } catch {
      return null;
    }
  }

  private async getForecastTargetTimes(): Promise<NowcastTime[] | null> {
    const cached = this.forecastTargetCache.get("forecast");
    if (cached !== undefined) return cached;
    try {
      const response = await this.fetchFn(FORECAST_TARGET_TIMES_URL, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) return null;
      const list = (await response.json()) as Array<{ basetime?: string; validtime?: string }>;
      const targets = list.flatMap((entry) => entry.basetime && entry.validtime
        ? [{ basetime: entry.basetime, validtime: entry.validtime }]
        : []);
      this.forecastTargetCache.set("forecast", targets, 60_000);
      return targets;
    } catch {
      return null;
    }
  }
}
