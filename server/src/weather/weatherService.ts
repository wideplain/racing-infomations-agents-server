import type { RainNowcastProvider, RainNowcastTimeline, WeatherSnapshotInput, WeatherSnapshotProvider } from "./types.js";
import { JmaAmedasClient } from "./amedasClient.js";
import { JmaNowcastClient } from "./nowcastClient.js";

function latestObservedAt(...values: Array<string | null>): string | null {
  const valid = values.filter((value): value is string => value !== null && Number.isFinite(new Date(value).getTime()));
  if (!valid.length) return null;
  return valid.reduce((latest, value) => (new Date(value) > new Date(latest) ? value : latest));
}

export class NoopWeatherSnapshotProvider implements WeatherSnapshotProvider {
  async getWeather(): Promise<WeatherSnapshotInput> {
    return {
      isRaining: null,
      precipitationIntensity: null,
      temperatureC: null,
      humidityPercent: null,
      windSpeedMs: null,
      weatherObservedAt: null,
      rainSourceObservedAt: null,
      amedasObservedAt: null,
      amedasStationId: null,
      amedasStationDistanceKm: null,
      source: { rain: null, temperature: null },
    };
  }
}

export class WeatherService implements WeatherSnapshotProvider, RainNowcastProvider {
  constructor(
    private nowcast = new JmaNowcastClient(),
    private amedas = new JmaAmedasClient()
  ) {}

  async getWeather(latitude: number, longitude: number): Promise<WeatherSnapshotInput> {
    const [rain, observation] = await Promise.all([
      this.nowcast.getRain(latitude, longitude),
      this.amedas.getObservation(latitude, longitude),
    ]);
    return {
      isRaining: rain.isRaining,
      // JMA's palette must not be reverse-engineered without an official, current mapping.
      precipitationIntensity: null,
      temperatureC: observation.temperatureC,
      humidityPercent: observation.humidityPercent,
      windSpeedMs: observation.windSpeedMs,
      weatherObservedAt: latestObservedAt(rain.observedAt, observation.observedAt),
      rainSourceObservedAt: rain.observedAt,
      amedasObservedAt: observation.observedAt,
      amedasStationId: observation.stationId,
      amedasStationDistanceKm: observation.stationDistanceKm,
      source: {
        rain: rain.isRaining === null ? null : "jma-nowcast",
        temperature: observation.observedAt === null ? null : "jma-amedas",
      },
    };
  }

  async getRainTimeline(latitude: number, longitude: number): Promise<RainNowcastTimeline | null> {
    return this.nowcast.getRainTimeline(latitude, longitude);
  }
}
