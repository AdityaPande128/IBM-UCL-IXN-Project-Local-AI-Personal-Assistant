import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const jarvisConfig = JSON.parse(
  readFileSync(fileURLToPath(new URL("../config.json", import.meta.url)), "utf8")
);
// The profile arrives over the socket; freezing it into the bundle would
// bake one user's name and photo into the build.
delete jarvisConfig.profile;

const host = process.env.TAURI_DEV_HOST;

// The daemon rotates its socket token every boot; outside the Tauri shell
// the dev page cannot read the file, so the dev server hands it over.
function devSocketToken(): Plugin {
  return {
    name: "jarvis-dev-socket-token",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__socket-token", (req, res) => {
        // Same-origin fetches carry no Origin header; anything that does is
        // another local page trying to borrow the daemon's credential.
        if (req.headers.origin) {
          res.statusCode = 403;
          res.end("");
          return;
        }
        try {
          const token = readFileSync(
            join(homedir(), ".jarvis", "socket-token"), "utf8").trim();
          res.setHeader("Content-Type", "text/plain");
          res.end(token);
        } catch {
          res.statusCode = 404;
          res.end("");
        }
      });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), devSocketToken()],

  define: {
    __JARVIS_CONFIG__: JSON.stringify(jarvisConfig),
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    cors: false,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
