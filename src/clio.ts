import type { AppConfig, ClioRegion } from "./config.js";
import { seal, unseal } from "./crypto.js";
import type { ClioSession, Store } from "./store.js";

type FetchLike = typeof fetch;

const CLIO_ORIGINS: Record<ClioRegion, string> = {
  US: "https://app.clio.com",
  EU: "https://eu.app.clio.com",
  CA: "https://ca.app.clio.com",
  AU: "https://au.app.clio.com",
};

type ClioTokenResponse = {
  token_type: string;
  access_token: string;
  expires_in: number;
  refresh_token?: string;
};

export class ClioApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class ClioService {
  private fetchImpl: FetchLike;
  private origin: string;

  constructor(private config: AppConfig, private store: Store, fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
    this.origin = CLIO_ORIGINS[config.clioRegion];
  }

  get authorizeUrl(): string { return `${this.origin}/oauth/authorize`; }

  assertConfigured(): void {
    if (!this.config.clioClientId || !this.config.clioClientSecret || !this.config.encryptionSecret) {
      throw new Error("The hosted app is not fully configured. An administrator must add the Clio credentials and encryption key.");
    }
  }

  async exchangeAuthorizationCode(code: string): Promise<ClioSession> {
    this.assertConfigured();
    const token = await this.tokenRequest({
      client_id: this.config.clioClientId!,
      client_secret: this.config.clioClientSecret!,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.clioRedirectUri,
    });
    if (!token.refresh_token) throw new Error("Clio did not return a refresh token.");
    const user = await this.rawApi(token.access_token, "/users/who_am_i", { fields: "id,name,time_zone,locale" });
    const userId = String(user?.data?.id || "");
    if (!userId) throw new Error("Clio did not return the connected user's ID.");
    return this.store.upsertClioSession({
      clioUserId: userId,
      region: this.config.clioRegion,
      accessTokenEncrypted: seal(token.access_token, this.config.encryptionSecret!),
      refreshTokenEncrypted: seal(token.refresh_token, this.config.encryptionSecret!),
      accessExpiresAt: new Date(Date.now() + token.expires_in * 1000),
    });
  }

  async api(sessionId: string, path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<any> {
    const token = await this.activeAccessToken(sessionId);
    return this.rawApi(token, path, query);
  }

  async activeAccessToken(sessionId: string): Promise<string> {
    this.assertConfigured();
    const session = await this.store.getClioSession(sessionId);
    if (!session) throw new Error("The Clio connection no longer exists. Please reconnect.");
    if (session.accessExpiresAt.getTime() > Date.now() + 5 * 60 * 1000) {
      return unseal(session.accessTokenEncrypted, this.config.encryptionSecret!);
    }
    const currentRefreshToken = unseal(session.refreshTokenEncrypted, this.config.encryptionSecret!);
    const token = await this.tokenRequest({
      client_id: this.config.clioClientId!,
      client_secret: this.config.clioClientSecret!,
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
    });
    const refreshToken = token.refresh_token || currentRefreshToken;
    await this.store.updateClioSessionTokens(
      session.id,
      seal(token.access_token, this.config.encryptionSecret!),
      seal(refreshToken, this.config.encryptionSecret!),
      new Date(Date.now() + token.expires_in * 1000),
    );
    return token.access_token;
  }

  private async tokenRequest(params: Record<string, string>): Promise<ClioTokenResponse> {
    const response = await this.fetchImpl(`${this.origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params),
    });
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      throw new ClioApiError(response.status, data?.error_description || data?.error?.message || "Clio authorization failed.");
    }
    if (!data.access_token || !data.expires_in) throw new Error("Clio returned an incomplete token response.");
    return data as ClioTokenResponse;
  }

  private async rawApi(accessToken: string, path: string, query: Record<string, string | number | boolean | undefined>): Promise<any> {
    const url = new URL(`${this.origin}/api/v4${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.fetchImpl(url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    const data = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `Clio request failed with ${response.status}.`;
      throw new ClioApiError(response.status, message);
    }
    return data;
  }
}

export function filterTasks(
  tasks: any[],
  options: { status: "pending" | "complete" | "all"; dueFrom?: string; dueTo?: string; assigneeId?: number },
): any[] {
  return tasks.filter((task) => {
    if (options.status !== "all" && String(task.status).toLowerCase() !== options.status) return false;
    if (options.assigneeId && Number(task.assignee?.id) !== options.assigneeId) return false;
    const due = task.due_at ? Date.parse(task.due_at) : undefined;
    if (options.dueFrom && (!due || due < Date.parse(options.dueFrom))) return false;
    if (options.dueTo && (!due || due > Date.parse(options.dueTo))) return false;
    return true;
  });
}
