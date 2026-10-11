import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev:web` serves the UI on :5173 and proxies the bridge, which runs
// with `npm run dev` (it then accepts the Vite origin as well).
const bridge = `http://127.0.0.1:${process.env.CONSOLE_PORT ?? 7801}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    host: "127.0.0.1",
    proxy: {
      "/ws": { target: bridge.replace("http", "ws"), ws: true },
      "/api": bridge,
    },
  },
});
