export interface RainForecast {
  /** Minutes until the next forecast period with a meaningful chance of rain. */
  etaMinutes: number;
  probability: number;
}

export interface WeatherForecast {
  /** Minutes until the forecast slot. Zero means the current/next available slot. */
  etaMinutes: number;
  weather: string;
}

export interface WeatherInfo {
  summaryText: string;
  fetchedAt: string;
  source: string;
  rainForecast?: RainForecast;
  weatherForecast?: WeatherForecast;
}

export interface WeatherProvider {
  getWeather(lat: number, lng: number): Promise<WeatherInfo | null>;
}

/** A point-in-time observation stored alongside a device location. `recordedAt` is the device
 * timestamp; the source timestamps deliberately remain independent because JMA data is not
 * produced once per device-minute. */
export interface WeatherSnapshot {
  recordedAt: string;
  latitude: number;
  longitude: number;
  isRaining: boolean | null;
  precipitationIntensity: number | null;
  temperatureC: number | null;
  humidityPercent: number | null;
  windSpeedMs: number | null;
  weatherObservedAt: string | null;
  rainSourceObservedAt: string | null;
  amedasObservedAt: string | null;
  amedasStationId: string | null;
  amedasStationDistanceKm: number | null;
  source: {
    rain: "jma-nowcast" | null;
    temperature: "jma-amedas" | null;
  };
}

export type WeatherSnapshotInput = Omit<WeatherSnapshot, "recordedAt" | "latitude" | "longitude">;

/** Separate from the forecast provider above: this reads current JMA observations for a stored
 * location and never throws to the location-ingestion path. */
export interface WeatherSnapshotProvider {
  getWeather(latitude: number, longitude: number): Promise<WeatherSnapshotInput>;
}

/** Five-minute precipitation forecasts for one point. These are intentionally separate from
 * WeatherSnapshot: AMeDAS supplies observations, not a point forecast for temperature or wind. */
export interface RainNowcastPoint {
  validAt: string;
  isRaining: boolean | null;
}

export interface RainNowcastTimeline {
  baseTime: string;
  points: RainNowcastPoint[];
}

export interface RainNowcastProvider {
  getRainTimeline(latitude: number, longitude: number): Promise<RainNowcastTimeline | null>;
}
