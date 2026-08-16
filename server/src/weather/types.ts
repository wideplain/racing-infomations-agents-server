export interface WeatherInfo {
  summaryText: string;
  fetchedAt: string;
  source: string;
}

export interface WeatherProvider {
  getWeather(lat: number, lng: number): Promise<WeatherInfo | null>;
}
