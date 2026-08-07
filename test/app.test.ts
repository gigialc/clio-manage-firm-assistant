import { describe, expect, it } from "vitest";
import request from "supertest";
import type { AppConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { ClioService } from "../src/clio.js";
import { pkceChallenge, seal, unseal, verifyPkce } from "../src/crypto.js";
import { MemoryStore } from "../src/store.js";

function config(): AppConfig {
  return {
    port: 3000,
    publicBaseUrl: "https://clio.example.test",
    mcpResourceUrl: "https://clio.example.test/mcp",
    clioClientId: "clio-client-id",
    clioClientSecret: "clio-client-secret",
    clioRedirectUri: "https://clio.example.test/oauth/clio/callback",
    clioRegion: "US",
    databaseUrl: undefined,
    databaseSsl: false,
    encryptionSecret: "a-very-long-random-test-secret-value-1234567890",
    allowInMemoryStore: true,
    trustProxy: false,
  };
}

function parseMcpResponse(response: request.Response): any {
  if (response.body && Object.keys(response.body).length) return response.body;
  const dataLine = response.text?.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`No MCP data event in response: ${response.text}`);
  return JSON.parse(dataLine.slice(6));
}

describe("security helpers", () => {
  it("round-trips encrypted values and verifies PKCE", () => {
    const secret = "a-very-long-random-test-secret-value-1234567890";
    const sealed = seal("private token", secret);
    expect(sealed).not.toContain("private token");
    expect(unseal(sealed, secret)).toBe("private token");
    const verifier = "v".repeat(64);
    expect(verifyPkce(verifier, pkceChallenge(verifier))).toBe(true);
    expect(verifyPkce("x".repeat(64), pkceChallenge(verifier))).toBe(false);
  });
});

describe("hosted Clio OAuth and MCP app", () => {
  it("publishes OAuth metadata and read-only tool auth metadata", async () => {
    const store = new MemoryStore();
    await store.init();
    const clio = new ClioService(config(), store, async () => new Response("{}", { status: 500 }));
    const app = createApp(config(), store, clio);

    const protectedMetadata = await request(app).get("/.well-known/oauth-protected-resource").expect(200);
    expect(protectedMetadata.body.resource).toBe("https://clio.example.test/mcp");

    const toolsResponse = await request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(200);
    const tools = parseMcpResponse(toolsResponse).result.tools;
    expect(tools).toHaveLength(5);
    expect(tools.every((tool: any) => tool.securitySchemes?.[0]?.type === "oauth2")).toBe(true);

    const callResponse = await request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "clio_who_am_i", arguments: {} } })
      .expect(200);
    const call = parseMcpResponse(callResponse).result;
    expect(call.isError).toBe(true);
    expect(call._meta["mcp/www_authenticate"][0]).toContain("oauth-protected-resource");
  });

  it("completes dynamic registration, Clio sign-in, PKCE exchange, and an authenticated tool call", async () => {
    const store = new MemoryStore();
    await store.init();
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/oauth/token") && init?.method === "POST") {
        return new Response(JSON.stringify({ token_type: "bearer", access_token: "clio-access", refresh_token: "clio-refresh", expires_in: 2592000 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/v4/users/who_am_i")) {
        return new Response(JSON.stringify({ data: { id: 42, name: "Pilot Lawyer", time_zone: "America/Los_Angeles" } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ error: { message: "Unexpected test URL" } }), { status: 500, headers: { "content-type": "application/json" } });
    };
    const appConfig = config();
    const clio = new ClioService(appConfig, store, fakeFetch);
    const app = createApp(appConfig, store, clio);

    const registration = await request(app).post("/oauth/register").send({
      client_name: "ChatGPT test client",
      redirect_uris: ["https://chatgpt.example.test/callback"],
      token_endpoint_auth_method: "none",
    }).expect(201);
    const verifier = "v".repeat(64);
    const authorization = await request(app).get("/oauth/authorize").query({
      response_type: "code",
      client_id: registration.body.client_id,
      redirect_uri: "https://chatgpt.example.test/callback",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      state: "chatgpt-state",
      resource: appConfig.mcpResourceUrl,
      scope: "clio.read",
    }).expect(302);
    const clioAuthorizeUrl = new URL(authorization.headers.location);
    expect(clioAuthorizeUrl.origin).toBe("https://app.clio.com");

    const callback = await request(app).get("/oauth/clio/callback").query({
      state: clioAuthorizeUrl.searchParams.get("state"),
      code: "clio-code",
    }).expect(302);
    const clientCallback = new URL(callback.headers.location);
    expect(clientCallback.searchParams.get("state")).toBe("chatgpt-state");

    const token = await request(app).post("/oauth/token").type("form").send({
      grant_type: "authorization_code",
      client_id: registration.body.client_id,
      redirect_uri: "https://chatgpt.example.test/callback",
      code: clientCallback.searchParams.get("code"),
      code_verifier: verifier,
    }).expect(200);
    expect(token.body.access_token).toMatch(/^mcp_at_/);

    const mcpCall = await request(app)
      .post("/mcp")
      .set("authorization", `Bearer ${token.body.access_token}`)
      .set("accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "clio_who_am_i", arguments: {} } })
      .expect(200);
    expect(parseMcpResponse(mcpCall).result.structuredContent.user.name).toBe("Pilot Lawyer");
  });
});
