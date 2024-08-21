import * as fsp from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import * as path from "node:path";

import { createMiddleware } from "@hattip/adapter-node";
import cloudflare, {
  type CloudflareDevEnvironment,
} from "@jacob-ebey/vite-cloudflare-plugin";
import { defineConfig } from "vite";
import ws from "ws";

export default defineConfig(({ command }) => ({
  dev: {
    optimizeDeps: {
      include: ["@cloudflare/kv-asset-handler"],
    },
  },
  define: {
    __KV_BINDINGS__: JSON.stringify([]),
    __PARTIES__: JSON.stringify([]),
    __R2_BINDINGS__: JSON.stringify([]),
  },
  resolve: {
    alias: {
      __WORKER__: path.resolve("src/server.ts"),
    },
  },
  environments: {
    client: {
      build: {
        outDir: "dist/browser",
        rollupOptions: {
          input: "index.html",
        },
      },
    },
    worker: {
      build: {
        copyPublicDir: false,
        outDir: "dist/worker",
        rollupOptions: {
          input: "adapter.js",
        },
      },
    },
  },
  builder: {
    async buildApp(builder) {
      await Promise.all([
        builder.build(builder.environments.client),
        builder.build(builder.environments.worker),
      ]);
    },
  },
  server: {
    hmr: {
      path: "/__vite_hmr",
    },
  },
  plugins: [
    cloudflare({
      environments: ["worker"],
    }),
    {
      name: "partykit",
      resolveId(source) {
        if (source === "__STATIC_CONTENT_MANIFEST") {
          return {
            id: source,
            external: true,
          };
        }
        if (source === "__STATIC_ASSETS_MANIFEST__") {
          if (command === "build") {
            return {
              id: path.resolve("assets_shim_prod.js"),
              external: true,
            };
          }
          return {
            id: path.resolve("assets_shim_dev.js"),
          };
        }
      },
    },
    {
      name: "dev-server",
      async configureServer(server) {
        const workerDevEnvironment = server.environments
          .worker as CloudflareDevEnvironment;

        const wss = new ws.Server({ noServer: true });
        if (!server.httpServer) {
          throw new Error("Server must have an http server");
        }

        server.httpServer.on(
          "upgrade",
          (request: IncomingMessage, socket, head) => {
            const url = new URL(request.url ?? "", "http://base.url");
            if (url.pathname === "/__vite_hmr") return;

            const headers = new Headers();
            for (const [key, value] of Object.entries(request.headers)) {
              if (typeof value === "string") {
                headers.append(key, value);
              } else if (Array.isArray(value)) {
                for (const v of value) {
                  headers.append(key, v);
                }
              }
            }

            wss.handleUpgrade(request, socket, head, async (ws) => {
              const response =
                await workerDevEnvironment.dispatchMiniflareFetch(
                  new Request(url, {
                    headers,
                    method: request.method,
                  })
                );

              const webSocket = response.webSocket;
              if (!webSocket) {
                socket.destroy();
                return;
              }

              webSocket.accept();
              webSocket.addEventListener("message", (event) => {
                ws.send(event.data);
              });
              ws.on("message", (data: ArrayBuffer | string) => {
                webSocket.send(data);
              });
              ws.on("close", () => {
                webSocket.close();
              });

              webSocket.addEventListener("close", () => {
                socket.destroy();
              });

              wss.emit("connection", ws, request);
            });
          }
        );

        const middleware = createMiddleware(
          (c) => {
            return workerDevEnvironment.dispatchFetch(c.request);
          },
          { alwaysCallNext: false }
        );

        return () => {
          server.middlewares.use(async (req, res, next) => {
            if (req.url === "/index.html") {
              let html = await fsp.readFile("index.html", "utf8");
              html = await server.transformIndexHtml(
                req.url || "/",
                html,
                req.originalUrl
              );
              res.setHeader("Content-Type", "text/html; charset=utf-8");
              res.end(html);
              return;
            }
            req.url = req.originalUrl;
            middleware(req, res, next);
          });
        };
      },
    },
  ],
}));
