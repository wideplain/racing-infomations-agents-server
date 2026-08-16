import type { DB } from "../db/index.js";
import { reserveWeatherSnapshot, updateWeatherSnapshot } from "../db/repo.js";
import type { WeatherSnapshotProvider } from "./types.js";

export interface WeatherSnapshotRecorder {
  recordLocations(
    sessionId: string,
    locations: Array<{ lat: number; lng: number; recordedAt: string }>
  ): void;
}

export class WeatherRecorder implements WeatherSnapshotRecorder {
  constructor(private db: DB, private weather: WeatherSnapshotProvider) {}

  recordLocations(sessionId: string, locations: Array<{ lat: number; lng: number; recordedAt: string }>): void {
    for (const location of locations) {
      const snapshot = reserveWeatherSnapshot(this.db, {
        sessionId,
        recordedAt: location.recordedAt,
        latitude: location.lat,
        longitude: location.lng,
      });
      if (!snapshot) continue;
      void this.weather.getWeather(location.lat, location.lng)
        .then((weather) => updateWeatherSnapshot(this.db, snapshot.id, weather))
        .catch((error) => console.warn("weather snapshot fetch failed", error));
    }
  }
}
