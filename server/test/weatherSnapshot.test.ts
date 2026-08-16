import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JmaAmedasClient } from "../src/weather/amedasClient.js";
import { isPngPixelOpaque, JmaNowcastClient, toTileCoordinate } from "../src/weather/nowcastClient.js";

function chunk(type: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 4, "ascii");
  // The production decoder deliberately does not need CRC values to read JMA's HTTPS tiles.
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function rgbaPng(width: number, height: number, pixels: number[]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows: number[] = [];
  for (let y = 0; y < height; y++) rows.push(0, ...pixels.slice(y * width * 4, (y + 1) * width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("JMA current-weather clients", () => {
  afterEach(() => vi.useRealTimers());

  it("maps Tokyo Station to the expected z=10 tile and pixel", () => {
    expect(toTileCoordinate(35.681236, 139.767125)).toEqual({ x: 909, y: 403, pixelX: 143, pixelY: 58 });
  });

  it("distinguishes transparent and painted RGBA pixels without guessing precipitation intensity", () => {
    const png = rgbaPng(2, 1, [0, 0, 0, 0, 10, 20, 30, 255]);
    expect(isPngPixelOpaque(png, 0, 0)).toBe(false);
    expect(isPngPixelOpaque(png, 1, 0)).toBe(true);
  });

  it("does not refetch a nowcast tile until JMA changes basetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    let basetime = "20260816090000";
    let targetCalls = 0;
    let tileCalls = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.includes("targetTimes_N1")) {
        targetCalls++;
        return new Response(JSON.stringify([{ basetime, validtime: basetime }]));
      }
      tileCalls++;
      return new Response(rgbaPng(256, 256, new Array(256 * 256 * 4).fill(0)));
    }) as unknown as typeof fetch;
    const client = new JmaNowcastClient({ fetchFn });

    await expect(client.getRain(35.681236, 139.767125)).resolves.toMatchObject({ isRaining: false });
    await expect(client.getRain(35.681236, 139.767125)).resolves.toMatchObject({ isRaining: false });
    expect(targetCalls).toBe(1);
    expect(tileCalls).toBe(1);

    basetime = "20260816090500";
    vi.advanceTimersByTime(61_000);
    await expect(client.getRain(35.681236, 139.767125)).resolves.toMatchObject({ isRaining: false });
    expect(targetCalls).toBe(2);
    expect(tileCalls).toBe(2);
  });

  it("returns the next hour of five-minute rain forecasts and caches their tiles", async () => {
    const forecastTimes = ["20260816100000", "20260816100500", "20260816101000"];
    let tileCalls = 0;
    const fetchFn = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.includes("targetTimes_N2")) {
        return new Response(JSON.stringify(forecastTimes.map((validtime) => ({ basetime: "20260816095500", validtime }))));
      }
      tileCalls++;
      return new Response(rgbaPng(256, 256, new Array(256 * 256 * 4).fill(0)));
    }) as unknown as typeof fetch;
    const client = new JmaNowcastClient({ fetchFn });

    await expect(client.getRainTimeline(35.681236, 139.767125)).resolves.toMatchObject({
      baseTime: "2026-08-16T00:55:00.000Z",
      points: [
        { validAt: "2026-08-16T01:00:00.000Z", isRaining: false },
        { validAt: "2026-08-16T01:05:00.000Z", isRaining: false },
        { validAt: "2026-08-16T01:10:00.000Z", isRaining: false },
      ],
    });
    await client.getRainTimeline(35.681236, 139.767125);
    expect(tileCalls).toBe(3);
  });

  it("returns null rain data rather than throwing when JMA fails", async () => {
    const client = new JmaNowcastClient({ fetchFn: (async () => { throw new Error("offline"); }) as typeof fetch });
    await expect(client.getRain(35.681236, 139.767125)).resolves.toEqual({ isRaining: null, observedAt: null });
  });

  it("uses the nearest AMeDAS station and turns missing values into null", async () => {
    const fetchFn = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("latest_time.txt")) return new Response("2026-08-16T12:00:00+09:00");
      if (value.endsWith("amedastable.json")) {
        return new Response(JSON.stringify({
          near: { lat: [35, 40.8], lon: [139, 46.0] },
          far: { lat: [36, 30.0], lon: [140, 0.0] },
        }));
      }
      return new Response(JSON.stringify({ near: { temp: [25.3, 0], humidity: [null, 0], wind: [2.4, 0] } }));
    }) as unknown as typeof fetch;
    const client = new JmaAmedasClient({ fetchFn });
    await expect(client.getObservation(35.681236, 139.767125)).resolves.toMatchObject({
      stationId: "near",
      temperatureC: 25.3,
      humidityPercent: null,
      windSpeedMs: 2.4,
    });
  });
});
