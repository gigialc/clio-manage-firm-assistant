import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { pkceChallenge, randomToken, tokenHash, verifyPkce } from "./crypto.js";
import { ClioService } from "./clio.js";
import type { McpGrant, PendingAuthorization, Store } from "./store.js";

const SUPPORTED_SCOPES = ["clio.read"];
const ACCESS_TOKEN_SECONDS = 60 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => handler(req, res).catch(next);
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function scopesFrom(value: unknown): string[] {
  const scopes = String(value || "clio.read").split(/\s+/).filter(Boolean);
  if (!scopes.length || scopes.some((scope) => !SUPPORTED_SCOPES.includes(scope))) {
    throw new OAuthRequestError("invalid_scope", "Only the clio.read scope is supported in this release.");
  }
  return [...new Set(scopes)];
}

class OAuthRequestError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export class StoreTokenVerifier implements OAuthTokenVerifier {
  constructor(private store: Store, private config: AppConfig) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = await this.store.getAccessGrant(tokenHash(token));
    if (!grant) throw new Error("Invalid or expired access token.");
    if (grant.resource !== this.config.mcpResourceUrl) throw new Error("The token was issued for another resource.");
    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: Math.floor(grant.expiresAt.getTime() / 1000),
      resource: new URL(grant.resource),
      extra: { sessionId: grant.sessionId },
    };
  }
}

async function issueTokenPair(store: Store, grant: Omit<McpGrant, "tokenHash" | "expiresAt">) {
  const accessToken = randomToken("mcp_at_");
  const refreshToken = randomToken("mcp_rt_");
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_SECONDS * 1000);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_SECONDS * 1000);
  await Promise.all([
    store.saveAccessGrant({ ...grant, tokenHash: tokenHash(accessToken), expiresAt: accessExpiresAt }),
    store.saveRefreshGrant({ ...grant, tokenHash: tokenHash(refreshToken), expiresAt: refreshExpiresAt }),
  ]);
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_SECONDS,
    refresh_token: refreshToken,
    scope: grant.scopes.join(" "),
  };
}

function redirectError(pending: PendingAuthorization, code: string, description: string): string {
  const url = new URL(pending.redirectUri);
  url.searchParams.set("error", code);
  url.searchParams.set("error_description", description);
  if (pending.originalState) url.searchParams.set("state", pending.originalState);
  return url.toString();
}

export function createOAuthRouter(config: AppConfig, store: Store, clio: ClioService): Router {
  const router = Router();

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: config.mcpResourceUrl,
      authorization_servers: [config.publicBaseUrl],
      scopes_supported: SUPPORTED_SCOPES,
      resource_documentation: `${config.publicBaseUrl}/docs`,
    });
  });

  const authMetadata = (_req: Request, res: Response) => {
    res.json({
      issuer: config.publicBaseUrl,
      authorization_endpoint: `${config.publicBaseUrl}/oauth/authorize`,
      token_endpoint: `${config.publicBaseUrl}/oauth/token`,
      registration_endpoint: `${config.publicBaseUrl}/oauth/register`,
      revocation_endpoint: `${config.publicBaseUrl}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: SUPPORTED_SCOPES,
    });
  };
  router.get("/.well-known/oauth-authorization-server", authMetadata);
  router.get("/.well-known/openid-configuration", authMetadata);

  router.post("/oauth/register", asyncRoute(async (req, res) => {
    const body = z.object({
      redirect_uris: z.array(z.string()).min(1).max(20),
      client_name: z.string().max(200).optional(),
      token_endpoint_auth_method: z.literal("none").optional(),
    }).passthrough().parse(req.body);
    if (!body.redirect_uris.every(validRedirectUri)) {
      throw new OAuthRequestError("invalid_redirect_uri", "Redirect URIs must use HTTPS or a loopback address.");
    }
    const clientId = randomToken("mcp_client_");
    const createdAt = new Date();
    await store.saveClient({ clientId, redirectUris: body.redirect_uris, clientName: body.client_name, createdAt });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt.getTime() / 1000),
      redirect_uris: body.redirect_uris,
      client_name: body.client_name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }));

  router.get("/oauth/authorize", asyncRoute(async (req, res) => {
    clio.assertConfigured();
    if (req.query.response_type !== "code") throw new OAuthRequestError("unsupported_response_type", "Only response_type=code is supported.");
    const clientId = z.string().parse(req.query.client_id);
    const redirectUri = z.string().parse(req.query.redirect_uri);
    const codeChallenge = z.string().min(43).max(128).parse(req.query.code_challenge);
    if (req.query.code_challenge_method !== "S256") throw new OAuthRequestError("invalid_request", "PKCE with S256 is required.");
    const resource = String(req.query.resource || config.mcpResourceUrl);
    if (resource !== config.mcpResourceUrl) throw new OAuthRequestError("invalid_target", "Unknown MCP resource.");
    const client = await store.getClient(clientId);
    if (!client || !client.redirectUris.includes(redirectUri)) throw new OAuthRequestError("invalid_request", "Unknown client or redirect URI.");
    const pending: PendingAuthorization = {
      id: randomToken("clio_state_"),
      clientId,
      redirectUri,
      codeChallenge,
      originalState: typeof req.query.state === "string" ? req.query.state : undefined,
      resource,
      scopes: scopesFrom(req.query.scope),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    };
    await store.savePendingAuthorization(pending);
    const url = new URL(clio.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clioClientId!);
    url.searchParams.set("redirect_uri", config.clioRedirectUri);
    url.searchParams.set("state", pending.id);
    url.searchParams.set("redirect_on_decline", "true");
    res.redirect(302, url.toString());
  }));

  router.get("/oauth/clio/callback", asyncRoute(async (req, res) => {
    const state = z.string().parse(req.query.state);
    const pending = await store.consumePendingAuthorization(state);
    if (!pending) throw new OAuthRequestError("invalid_request", "The sign-in request expired. Start the connection again.");
    if (req.query.error) {
      res.redirect(302, redirectError(pending, String(req.query.error), "Clio authorization was not completed."));
      return;
    }
    const code = z.string().parse(req.query.code);
    try {
      const session = await clio.exchangeAuthorizationCode(code);
      const authorizationCode = randomToken("mcp_code_");
      await store.saveAuthorizationCode({
        code: authorizationCode,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        sessionId: session.id,
        resource: pending.resource,
        scopes: pending.scopes,
        codeChallenge: pending.codeChallenge,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
      const redirect = new URL(pending.redirectUri);
      redirect.searchParams.set("code", authorizationCode);
      if (pending.originalState) redirect.searchParams.set("state", pending.originalState);
      res.redirect(302, redirect.toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Clio authorization failed.";
      res.redirect(302, redirectError(pending, "access_denied", message));
    }
  }));

  router.post("/oauth/token", asyncRoute(async (req, res) => {
    const grantType = String(req.body.grant_type || "");
    if (grantType === "authorization_code") {
      const clientId = z.string().parse(req.body.client_id);
      const code = z.string().parse(req.body.code);
      const redirectUri = z.string().parse(req.body.redirect_uri);
      const verifier = z.string().min(43).max(128).parse(req.body.code_verifier);
      const stored = await store.consumeAuthorizationCode(code);
      if (!stored || stored.clientId !== clientId || stored.redirectUri !== redirectUri || !verifyPkce(verifier, stored.codeChallenge)) {
        throw new OAuthRequestError("invalid_grant", "The authorization code or PKCE verifier is invalid.");
      }
      res.json(await issueTokenPair(store, {
        clientId,
        sessionId: stored.sessionId,
        resource: stored.resource,
        scopes: stored.scopes,
      }));
      return;
    }
    if (grantType === "refresh_token") {
      const clientId = z.string().parse(req.body.client_id);
      const stored = await store.consumeRefreshGrant(tokenHash(z.string().parse(req.body.refresh_token)));
      if (!stored || stored.clientId !== clientId) throw new OAuthRequestError("invalid_grant", "The refresh token is invalid or expired.");
      res.json(await issueTokenPair(store, {
        clientId,
        sessionId: stored.sessionId,
        resource: stored.resource,
        scopes: stored.scopes,
      }));
      return;
    }
    throw new OAuthRequestError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  }));

  router.post("/oauth/revoke", asyncRoute(async (req, res) => {
    if (req.body.token) await store.revokeGrant(tokenHash(String(req.body.token)));
    res.status(200).end();
  }));

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof OAuthRequestError) {
      res.status(error.status).json({ error: error.code, error_description: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "invalid_request", error_description: "A required OAuth parameter is missing or invalid." });
      return;
    }
    next(error);
  });

  return router;
}

export function optionalBearerAuth(verifier: StoreTokenVerifier, config: AppConfig) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    if (!header) return next();
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      res.status(401).set("WWW-Authenticate", `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource"`).json({ error: "invalid_token" });
      return;
    }
    try {
      (req as Request & { auth?: AuthInfo }).auth = await verifier.verifyAccessToken(match[1]);
      next();
    } catch {
      res.status(401).set("WWW-Authenticate", `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`).json({ error: "invalid_token" });
    }
  };
}

export function authChallenge(config: AppConfig) {
  const challenge = `Bearer resource_metadata="${config.publicBaseUrl}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="Connect your Clio account to continue"`;
  return {
    content: [{ type: "text" as const, text: "Connect your Clio account to continue." }],
    isError: true,
    _meta: { "mcp/www_authenticate": [challenge] },
  };
}
