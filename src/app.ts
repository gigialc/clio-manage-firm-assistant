import type { NextFunction, Request, Response } from "express";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { deploymentReadiness } from "./config.js";
import { ClioService } from "./clio.js";
import { createMcpServer } from "./mcp.js";
import { createOAuthRouter, optionalBearerAuth, StoreTokenVerifier } from "./oauth.js";
import type { Store } from "./store.js";

export function createApp(config: AppConfig, store: Store, clio: ClioService) {
  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.get("/setup-status", (_req, res) => {
    const status = deploymentReadiness(config);
    res.status(status.ready ? 200 : 503).json({
      ready: status.ready,
      missing: status.missing,
      clio_redirect_uri: config.clioRedirectUri,
      mcp_url: config.mcpResourceUrl,
    });
  });
  app.get("/docs", (_req, res) => {
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Clio Manage Assistant</title></head><body><main><h1>Clio Manage Assistant</h1><p>This private, read-only connector lets authorized firm users review visible Clio calendars and tasks in ChatGPT and Codex.</p><p>It follows each user's existing Clio permissions. Contact your firm's administrator for access.</p></main></body></html>`);
  });

  app.use(createOAuthRouter(config, store, clio));
  const verifier = new StoreTokenVerifier(store, config);
  const bearer = optionalBearerAuth(verifier, config);

  app.post("/mcp", bearer, async (req, res) => {
    const server = createMcpServer(config, clio);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  app.get("/mcp", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
  app.delete("/mcp", (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("Request failed", error instanceof Error ? error.message : "Unknown error");
    if (!res.headersSent) res.status(500).json({ error: "server_error", message: "The request could not be completed." });
  });
  return app;
}
