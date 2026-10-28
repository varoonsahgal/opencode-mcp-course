// Lab 3 starter: a weather MCP server backed by the free Open-Meteo API (no API key needed).
//
// Run it:        npx tsx src/server.ts            (then Ctrl+C)
// Inspect it:    npx @modelcontextprotocol/inspector --cli npx tsx src/server.ts --method tools/list
//
// Rule #1 of stdio servers: stdout is the protocol channel. Log with console.error, never console.log.

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

// ---------------------------------------------------------------------------
// Helpers (complete, nothing to change here)
// ---------------------------------------------------------------------------

/** WMO weather interpretation codes, trimmed to the ones you will actually see. */
const WMO: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog",
  51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 61: "light rain", 63: "rain", 65: "heavy rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "heavy rain showers",
  82: "violent rain showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
};

type Place = { name: string; country: string; latitude: number; longitude: number; timezone: string };

/** Turn a city name into coordinates. Returns null when nothing matches. */
async function geocode(city: string): Promise<Place | null> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", city);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`geocoding failed with HTTP ${res.status}`);
  const data = (await res.json()) as { results?: Place[] };
  return data.results?.[0] ?? null;
}

type Current = { temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number; time: string };

/** Fetch current conditions for a coordinate. */
async function currentWeather(lat: number, lon: number): Promise<Current> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("current", "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m");
  url.searchParams.set("timezone", "auto");
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`forecast failed with HTTP ${res.status}`);
  const data = (await res.json()) as { current: Current };
  return data.current;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

serveStdio(() => {
  const server = new McpServer({ name: "weather", version: "0.1.0" });

  // TODO 1 — register a tool called "get_weather".
  //   input:  { city: string }
  //   steps:  geocode(city) -> currentWeather(lat, lon) -> return a short text summary
  //   errors: unknown city -> return { isError: true, content: [...] } with a helpful hint
  //
  // TODO 2 (stretch) — add annotations + an outputSchema with structuredContent.
  // TODO 3 (stretch) — add a resource "weather://wmo-codes" and a prompt "trip-briefing".

  return server;
});

console.error("weather MCP server running on stdio");
