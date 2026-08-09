import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const jarvisConfig = JSON.parse(
  readFileSync(fileURLToPath(new URL("../config.json", import.meta.url)), "utf8")
);

export default defineConfig({
  plugins: [react()],
  define: {
    __JARVIS_CONFIG__: JSON.stringify(jarvisConfig),
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
  },
  server: {
    port: 3000,
  },
});
