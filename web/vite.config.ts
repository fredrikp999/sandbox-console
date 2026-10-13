import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { protocolHash } from "../server/build.ts";

// `npm run dev:web` serves the UI on :5173 and proxies the bridge, which runs
// with `npm run dev` (it then accepts the Vite origin as well).
const bridge = `http://127.0.0.1:${process.env.CONSOLE_PORT ?? 7801}`;

export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  plugins: [react()],
  // The protocol this page was built with; the bridge says which one it runs (server/build.ts).
  define: { __PROTOCOL__: JSON.stringify(protocolHash()) },
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/ws": { target: bridge.replace("http", "ws"), ws: true },
      "/api": bridge,
    },
  },
});
