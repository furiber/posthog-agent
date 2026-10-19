import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";

export default defineConfig({
  plugins: [cloudflare(), agents()],
});
