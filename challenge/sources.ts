import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotenv, type EnvSource } from "./env.ts";

const here = dirname(fileURLToPath(import.meta.url));

function fileSource(label: string, path: string): EnvSource | null {
  return existsSync(path) ? { name: label, vars: parseDotenv(readFileSync(path, "utf8")) } : null;
}

/** Where the OpenRouter key may live, in priority order: process env, challenge/.env, the repo's .env. */
export function loadSources(): EnvSource[] {
  return [
    { name: "process env", vars: process.env },
    fileSource("challenge/.env", join(here, ".env")),
    fileSource("root .env", join(here, "..", ".env")),
  ].filter((s): s is EnvSource => s !== null);
}
