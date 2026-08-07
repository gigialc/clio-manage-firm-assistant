import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export type OAuthClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: Date;
};

export type PendingAuthorization = {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  originalState?: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
};

export type AuthorizationCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  sessionId: string;
  resource: string;
  scopes: string[];
  codeChallenge: string;
  expiresAt: Date;
};

export type ClioSession = {
  id: string;
  clioUserId: string;
  region: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  accessExpiresAt: Date;
};

export type McpGrant = {
  tokenHash: string;
  clientId: string;
  sessionId: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
};

export interface Store {
  init(): Promise<void>;
  saveClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | undefined>;
  savePendingAuthorization(request: PendingAuthorization): Promise<void>;
  consumePendingAuthorization(id: string): Promise<PendingAuthorization | undefined>;
  saveAuthorizationCode(code: AuthorizationCode): Promise<void>;
  consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined>;
  upsertClioSession(session: Omit<ClioSession, "id">): Promise<ClioSession>;
  getClioSession(id: string): Promise<ClioSession | undefined>;
  updateClioSessionTokens(id: string, accessTokenEncrypted: string, refreshTokenEncrypted: string, accessExpiresAt: Date): Promise<void>;
  saveAccessGrant(grant: McpGrant): Promise<void>;
  getAccessGrant(tokenHash: string): Promise<McpGrant | undefined>;
  saveRefreshGrant(grant: McpGrant): Promise<void>;
  consumeRefreshGrant(tokenHash: string): Promise<McpGrant | undefined>;
  revokeGrant(tokenHash: string): Promise<void>;
}

function active<T extends { expiresAt: Date }>(value?: T): T | undefined {
  return value && value.expiresAt.getTime() > Date.now() ? value : undefined;
}

export class MemoryStore implements Store {
  private clients = new Map<string, OAuthClient>();
  private pending = new Map<string, PendingAuthorization>();
  private codes = new Map<string, AuthorizationCode>();
  private sessions = new Map<string, ClioSession>();
  private sessionByUser = new Map<string, string>();
  private accessGrants = new Map<string, McpGrant>();
  private refreshGrants = new Map<string, McpGrant>();

  async init(): Promise<void> {}

  async saveClient(client: OAuthClient): Promise<void> { this.clients.set(client.clientId, client); }
  async getClient(clientId: string): Promise<OAuthClient | undefined> { return this.clients.get(clientId); }
  async savePendingAuthorization(request: PendingAuthorization): Promise<void> { this.pending.set(request.id, request); }
  async consumePendingAuthorization(id: string): Promise<PendingAuthorization | undefined> {
    const value = this.pending.get(id);
    this.pending.delete(id);
    return active(value);
  }
  async saveAuthorizationCode(code: AuthorizationCode): Promise<void> { this.codes.set(code.code, code); }
  async consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined> {
    const value = this.codes.get(code);
    this.codes.delete(code);
    return active(value);
  }
  async upsertClioSession(input: Omit<ClioSession, "id">): Promise<ClioSession> {
    const key = `${input.region}:${input.clioUserId}`;
    const id = this.sessionByUser.get(key) || randomUUID();
    const session = { id, ...input };
    this.sessions.set(id, session);
    this.sessionByUser.set(key, id);
    return session;
  }
  async getClioSession(id: string): Promise<ClioSession | undefined> { return this.sessions.get(id); }
  async updateClioSessionTokens(id: string, accessTokenEncrypted: string, refreshTokenEncrypted: string, accessExpiresAt: Date): Promise<void> {
    const current = this.sessions.get(id);
    if (!current) return;
    this.sessions.set(id, { ...current, accessTokenEncrypted, refreshTokenEncrypted, accessExpiresAt });
  }
  async saveAccessGrant(grant: McpGrant): Promise<void> { this.accessGrants.set(grant.tokenHash, grant); }
  async getAccessGrant(hash: string): Promise<McpGrant | undefined> { return active(this.accessGrants.get(hash)); }
  async saveRefreshGrant(grant: McpGrant): Promise<void> { this.refreshGrants.set(grant.tokenHash, grant); }
  async consumeRefreshGrant(hash: string): Promise<McpGrant | undefined> {
    const value = this.refreshGrants.get(hash);
    this.refreshGrants.delete(hash);
    return active(value);
  }
  async revokeGrant(hash: string): Promise<void> {
    this.accessGrants.delete(hash);
    this.refreshGrants.delete(hash);
  }
}

export class PostgresStore implements Store {
  private pool: Pool;

  constructor(databaseUrl: string, ssl: boolean) {
    this.pool = new Pool({ connectionString: databaseUrl, ssl: ssl ? { rejectUnauthorized: true } : undefined });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id text PRIMARY KEY,
        redirect_uris jsonb NOT NULL,
        client_name text,
        created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_authorizations (
        id text PRIMARY KEY,
        client_id text NOT NULL,
        redirect_uri text NOT NULL,
        code_challenge text NOT NULL,
        original_state text,
        resource text NOT NULL,
        scopes jsonb NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS authorization_codes (
        code text PRIMARY KEY,
        client_id text NOT NULL,
        redirect_uri text NOT NULL,
        session_id uuid NOT NULL,
        resource text NOT NULL,
        scopes jsonb NOT NULL,
        code_challenge text NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clio_sessions (
        id uuid PRIMARY KEY,
        clio_user_id text NOT NULL,
        region text NOT NULL,
        access_token_encrypted text NOT NULL,
        refresh_token_encrypted text NOT NULL,
        access_expires_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (region, clio_user_id)
      );
      CREATE TABLE IF NOT EXISTS mcp_access_grants (
        token_hash text PRIMARY KEY,
        client_id text NOT NULL,
        session_id uuid NOT NULL,
        resource text NOT NULL,
        scopes jsonb NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_refresh_grants (
        token_hash text PRIMARY KEY,
        client_id text NOT NULL,
        session_id uuid NOT NULL,
        resource text NOT NULL,
        scopes jsonb NOT NULL,
        expires_at timestamptz NOT NULL
      );
    `);
  }

  async saveClient(client: OAuthClient): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (client_id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris, client_name = EXCLUDED.client_name`,
      [client.clientId, JSON.stringify(client.redirectUris), client.clientName || null, client.createdAt],
    );
  }
  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    const result = await this.pool.query(`SELECT * FROM oauth_clients WHERE client_id = $1`, [clientId]);
    const row = result.rows[0];
    return row ? { clientId: row.client_id, redirectUris: row.redirect_uris, clientName: row.client_name || undefined, createdAt: row.created_at } : undefined;
  }
  async savePendingAuthorization(value: PendingAuthorization): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_authorizations VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [value.id, value.clientId, value.redirectUri, value.codeChallenge, value.originalState || null, value.resource, JSON.stringify(value.scopes), value.expiresAt],
    );
  }
  async consumePendingAuthorization(id: string): Promise<PendingAuthorization | undefined> {
    const result = await this.pool.query(`DELETE FROM pending_authorizations WHERE id = $1 AND expires_at > now() RETURNING *`, [id]);
    const row = result.rows[0];
    return row ? { id: row.id, clientId: row.client_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge, originalState: row.original_state || undefined, resource: row.resource, scopes: row.scopes, expiresAt: row.expires_at } : undefined;
  }
  async saveAuthorizationCode(value: AuthorizationCode): Promise<void> {
    await this.pool.query(
      `INSERT INTO authorization_codes VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [value.code, value.clientId, value.redirectUri, value.sessionId, value.resource, JSON.stringify(value.scopes), value.codeChallenge, value.expiresAt],
    );
  }
  async consumeAuthorizationCode(code: string): Promise<AuthorizationCode | undefined> {
    const result = await this.pool.query(`DELETE FROM authorization_codes WHERE code = $1 AND expires_at > now() RETURNING *`, [code]);
    const row = result.rows[0];
    return row ? { code: row.code, clientId: row.client_id, redirectUri: row.redirect_uri, sessionId: row.session_id, resource: row.resource, scopes: row.scopes, codeChallenge: row.code_challenge, expiresAt: row.expires_at } : undefined;
  }
  async upsertClioSession(value: Omit<ClioSession, "id">): Promise<ClioSession> {
    const result = await this.pool.query(
      `INSERT INTO clio_sessions (id, clio_user_id, region, access_token_encrypted, refresh_token_encrypted, access_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (region, clio_user_id) DO UPDATE SET
         access_token_encrypted = EXCLUDED.access_token_encrypted,
         refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
         access_expires_at = EXCLUDED.access_expires_at,
         updated_at = now()
       RETURNING *`,
      [randomUUID(), value.clioUserId, value.region, value.accessTokenEncrypted, value.refreshTokenEncrypted, value.accessExpiresAt],
    );
    return this.sessionFromRow(result.rows[0]);
  }
  async getClioSession(id: string): Promise<ClioSession | undefined> {
    const result = await this.pool.query(`SELECT * FROM clio_sessions WHERE id = $1`, [id]);
    return result.rows[0] ? this.sessionFromRow(result.rows[0]) : undefined;
  }
  async updateClioSessionTokens(id: string, accessTokenEncrypted: string, refreshTokenEncrypted: string, accessExpiresAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE clio_sessions SET access_token_encrypted=$2, refresh_token_encrypted=$3, access_expires_at=$4, updated_at=now() WHERE id=$1`,
      [id, accessTokenEncrypted, refreshTokenEncrypted, accessExpiresAt],
    );
  }
  async saveAccessGrant(value: McpGrant): Promise<void> { await this.saveGrant("mcp_access_grants", value); }
  async getAccessGrant(hash: string): Promise<McpGrant | undefined> {
    const result = await this.pool.query(`SELECT * FROM mcp_access_grants WHERE token_hash=$1 AND expires_at > now()`, [hash]);
    return result.rows[0] ? this.grantFromRow(result.rows[0]) : undefined;
  }
  async saveRefreshGrant(value: McpGrant): Promise<void> { await this.saveGrant("mcp_refresh_grants", value); }
  async consumeRefreshGrant(hash: string): Promise<McpGrant | undefined> {
    const result = await this.pool.query(`DELETE FROM mcp_refresh_grants WHERE token_hash=$1 AND expires_at > now() RETURNING *`, [hash]);
    return result.rows[0] ? this.grantFromRow(result.rows[0]) : undefined;
  }
  async revokeGrant(hash: string): Promise<void> {
    await Promise.all([
      this.pool.query(`DELETE FROM mcp_access_grants WHERE token_hash=$1`, [hash]),
      this.pool.query(`DELETE FROM mcp_refresh_grants WHERE token_hash=$1`, [hash]),
    ]);
  }
  private async saveGrant(table: "mcp_access_grants" | "mcp_refresh_grants", value: McpGrant): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${table} (token_hash,client_id,session_id,resource,scopes,expires_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [value.tokenHash, value.clientId, value.sessionId, value.resource, JSON.stringify(value.scopes), value.expiresAt],
    );
  }
  private sessionFromRow(row: Record<string, any>): ClioSession {
    return { id: row.id, clioUserId: row.clio_user_id, region: row.region, accessTokenEncrypted: row.access_token_encrypted, refreshTokenEncrypted: row.refresh_token_encrypted, accessExpiresAt: row.access_expires_at };
  }
  private grantFromRow(row: Record<string, any>): McpGrant {
    return { tokenHash: row.token_hash, clientId: row.client_id, sessionId: row.session_id, resource: row.resource, scopes: row.scopes, expiresAt: row.expires_at };
  }
}

export function createStore(databaseUrl: string | undefined, ssl: boolean, allowInMemory: boolean): Store {
  if (databaseUrl) return new PostgresStore(databaseUrl, ssl);
  if (allowInMemory) return new MemoryStore();
  throw new Error("DATABASE_URL is required in production. In-memory storage is not durable or safe for a firm rollout.");
}
