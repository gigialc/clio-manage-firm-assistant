import { z } from "zod";

const regionSchema = z.enum(["US", "EU", "CA", "AU"]);

export type ClioRegion = z.infer<typeof regionSchema>;

export type AppConfig = {
  port: number;
  publicBaseUrl: string;
  mcpResourceUrl: string;
  clioClientId?: string;
  clioClientSecret?: string;
  clioRedirectUri: string;
  clioRegion: ClioRegion;
  databaseUrl?: string;
  databaseSsl: boolean;
  encryptionSecret?: string;
  allowInMemoryStore: boolean;
  trustProxy: boolean;
};

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_BASE_URL must be an origin without a path, query, or fragment.");
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = z.coerce.number().int().min(1).max(65535).default(3000).parse(env.PORT);
  const discoveredBaseUrl = env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
  const publicBaseUrl = normalizedOrigin(discoveredBaseUrl);
  const clioRegion = regionSchema.default("US").parse(env.CLIO_REGION);
  const allowInMemoryStore = env.ALLOW_IN_MEMORY_STORE === "true" || env.NODE_ENV !== "production";

  return {
    port,
    publicBaseUrl,
    mcpResourceUrl: `${publicBaseUrl}/mcp`,
    clioClientId: env.CLIO_CLIENT_ID || undefined,
    clioClientSecret: env.CLIO_CLIENT_SECRET || undefined,
    clioRedirectUri: env.CLIO_REDIRECT_URI || `${publicBaseUrl}/oauth/clio/callback`,
    clioRegion,
    databaseUrl: env.DATABASE_URL || undefined,
    databaseSsl: env.DATABASE_SSL === "true",
    encryptionSecret: env.TOKEN_ENCRYPTION_KEY || undefined,
    allowInMemoryStore,
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
  };
}

export function deploymentReadiness(config: AppConfig): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!config.clioClientId) missing.push("CLIO_CLIENT_ID");
  if (!config.clioClientSecret) missing.push("CLIO_CLIENT_SECRET");
  if (!config.databaseUrl && !config.allowInMemoryStore) missing.push("DATABASE_URL");
  if (!config.encryptionSecret) missing.push("TOKEN_ENCRYPTION_KEY");
  if (!config.publicBaseUrl.startsWith("https://") && process.env.NODE_ENV === "production") {
    missing.push("PUBLIC_BASE_URL (HTTPS)");
  }
  return { ready: missing.length === 0, missing };
}
