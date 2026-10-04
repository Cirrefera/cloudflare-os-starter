import { DurableObject } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ConnectHandoff, GatekeeperConnectCallback, GatekeeperUser } from "@gadgets/workshop-shared/gatekeeper";
import { advanceToOAuth, claimOAuth, putInitiation } from "@gadgets/gatekeeper-kit/connect-handshake";
import { CONNECT_TIMEOUT_MS, generateNonce } from "@gadgets/gatekeeper-kit/connect-nonce";
import { connectHandoffPageHtml, errorPageHtml, htmlResponse } from "@gadgets/gatekeeper-kit/connect-pages";
import { notifyCredentialsExpiredOnce } from "@gadgets/gatekeeper-kit/credential-expiry";
import { commitStagedCredentials, discardStagedCredentials, stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { CredentialCoordinator } from "@gadgets/gatekeeper-kit/credentials";
import { createPkce, mergeOAuthTokens, OAuthClient, oauthRefresh, type OAuthGrant } from "@gadgets/gatekeeper-kit/oauth-client";

type Grant = OAuthGrant & { user: string };
type Attempt = { verifier: string; generation: string; reconnect: boolean };
type ReconnectGrant = { grant: Grant; generation: string };

/** The private credential projection used by Snowflake API calls; refresh tokens stay in the DO. */
export type SnowflakeCredential = { accessToken: string };

/** The configured Snowflake account origin, restricted to Snowflake's HTTPS account hosts. */
export function accountOrigin(env: Env): string {
  if (!env.SNOWFLAKE_ACCOUNT || !env.SNOWFLAKE_ROLE) throw new Error("Configure the Snowflake account and role.");
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(env.SNOWFLAKE_ROLE)) throw new Error("Invalid configured Snowflake role.");
  const url = new URL(env.SNOWFLAKE_BASE_URL ?? `https://${env.SNOWFLAKE_ACCOUNT}.snowflakecomputing.com`);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".snowflakecomputing.com") || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Configure an HTTPS Snowflake account origin without a path.");
  }
  return url.origin;
}

/** Router-mounted base URL of the Snowflake connection endpoints. */
export function connectionBase(env: Env): string {
  if (!env.BASE_URL) throw new Error("Configure the Snowflake gatekeeper BASE_URL.");
  return env.BASE_URL.replace(/\/+$/, "");
}

function client(env: Env): OAuthClient {
  if (!env.CLIENT_ID || !env.CLIENT_SECRET) throw new Error("Configure the Snowflake OAuth application's CLIENT_ID and CLIENT_SECRET.");
  const origin = accountOrigin(env);
  return new OAuthClient({
    label: "Snowflake", client: { method: "basic", id: env.CLIENT_ID, secret: env.CLIENT_SECRET },
    authorizationEndpoint: `${origin}/oauth/authorize`, tokenEndpoint: `${origin}/oauth/token-request`,
    ...(env.SNOWFLAKE_OAUTH_REVOCATION_URL ? { revocationEndpoint: env.SNOWFLAKE_OAUTH_REVOCATION_URL } : {}),
    defaultExpiresIn: 600,
  });
}

/** One human's Snowflake connection, using the upstream credential and connection primitives. */
@validateRpc()
export class SnowflakeConnection extends DurableObject<Env> {
  readonly #credentials = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt, vendorId: "snowflake",
  });

  #refresh() {
    return oauthRefresh<Grant>(client(this.env), {
      refreshToken: grant => grant.refreshToken, merge: mergeOAuthTokens,
      expiredMessage: "Reconnect your Snowflake account.",
    });
  }

  #notify() {
    return notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), "snowflake");
  }

  async prepare(callback: Fetcher<GatekeeperConnectCallback>): Promise<string> {
    client(this.env);
    connectionBase(this.env);
    this.ctx.storage.kv.put("callback", callback);
    const nonce = generateNonce();
    putInitiation(this.ctx.storage.kv, nonce, Date.now());
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    return `${connectionBase(this.env)}/${this.ctx.id}/${nonce}`;
  }

  async reconnect(): Promise<{ url: string }> {
    client(this.env);
    if (!this.ctx.storage.kv.get("callback")) throw new Error("Start a new Snowflake connection.");
    discardStagedCredentials(this.ctx.storage.kv);
    const nonce = generateNonce();
    putInitiation(this.ctx.storage.kv, nonce, Date.now());
    return { url: `${connectionBase(this.env)}/${this.ctx.id}/${nonce}` };
  }

  async authorize(initiationNonce: string): Promise<string | null> {
    const pkce = await createPkce();
    const generation = this.#credentials.connectionGeneration();
    const state = advanceToOAuth(this.ctx.storage.kv, initiationNonce, Date.now(), {
      verifier: pkce.codeVerifier, generation, reconnect: this.#credentials.stored() !== undefined,
    });
    if (state === null) return null;
    return client(this.env).authorizationUrl({
      redirectUri: `${connectionBase(this.env)}/oauth`, state: `${this.ctx.id}:${state}`,
      scopes: ["refresh_token", `session:role:${this.env.SNOWFLAKE_ROLE}`], codeChallenge: pkce.codeChallenge,
    }).toString();
  }

  async complete(code: string, state: string): Promise<ConnectHandoff | null> {
    const attempt = claimOAuth<Attempt>(this.ctx.storage.kv, state, Date.now());
    if (attempt === null) return null;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Start a new Snowflake connection.");
    const tokens = await client(this.env).exchangeCode({
      code, codeVerifier: attempt.verifier, redirectUri: `${connectionBase(this.env)}/oauth`,
    });
    if (!tokens.refreshToken) throw new Error("Enable refresh tokens on the Snowflake OAuth application and connect again.");
    // Confirm the configured role is usable and record provider-confirmed identity, not token claims.
    const response = await fetch(`${accountOrigin(this.env)}/api/v2/statements`, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${tokens.accessToken}`, "X-Snowflake-Authorization-Token-Type": "OAUTH", "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ statement: "SELECT CURRENT_USER()", role: this.env.SNOWFLAKE_ROLE, timeout: 30 }),
    });
    if (!response.ok) throw new Error(`Snowflake could not verify this user and role (HTTP ${response.status}).`);
    const identity = await response.json() as { data?: unknown[][] };
    const user = identity.data?.[0]?.[0];
    if (typeof user !== "string" || !user) throw new Error("Snowflake did not return the connected user's identity.");
    const grant: Grant = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt, scopes: tokens.scopes, user };
    if (this.#credentials.connectionGeneration() !== attempt.generation) throw new Error("This connection changed; start again.");
    if (attempt.reconnect) {
      if (this.#credentials.stored()?.user !== user) throw new Error("Reconnect using the original Snowflake user, or add a separate connection.");
      const stageId = stageCredentials(this.ctx.storage.kv, { grant, generation: attempt.generation }, Date.now());
      return callback.reconnectComplete(stageId);
    }
    this.#credentials.connect(grant, { ifGeneration: attempt.generation });
    const connectedGeneration = this.#credentials.connectionGeneration();
    try {
      // The account implements GatekeeperUser; narrowing this factory avoids recursively mapping
      // its Snowflake session through both the loopback and callback RPC type transformations.
      const mintAccount = this.ctx.exports.SnowflakeAccount as unknown as
        (options: { props: { connectionId: string } }) => Fetcher<GatekeeperUser>;
      const handoff = await callback.complete(mintAccount({ props: { connectionId: this.ctx.id.toString() } }));
      await this.ctx.storage.deleteAlarm();
      return handoff;
    } catch (error) {
      // Never clear a successor if an RPC completion raced with a reconnect.
      if (this.#credentials.connectionGeneration() === connectedGeneration) this.#credentials.clear();
      throw error;
    }
  }

  commitReconnect(stageId: string): void {
    const staged = commitStagedCredentials<ReconnectGrant>(this.ctx.storage.kv, Date.now(), stageId);
    if (!staged) throw new Error("The Snowflake reconnect expired; start again.");
    this.#credentials.connect(staged.grant, { ifGeneration: staged.generation });
  }

  async getCredentials() {
    const read = await this.#credentials.snapshot(this.#refresh(), { notify: () => this.#notify() });
    return { creds: { accessToken: read.creds.accessToken }, identity: read.identity, generation: read.generation };
  }

  reportCredentialsRejected(identity: string) {
    return this.#credentials.adjudicateRejection(identity, { refresh: this.#refresh(), notify: () => this.#notify() });
  }

  async describeUser(): Promise<string> {
    await this.getCredentials();
    return this.#credentials.stored()!.user;
  }

  async revoke(): Promise<void> {
    const grant = this.#credentials.stored();
    this.#credentials.clear();
    discardStagedCredentials(this.ctx.storage.kv);
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("callback");
    await this.ctx.storage.deleteAlarm();
    // Snowflake configurations vary; never invent a provider revocation endpoint.
    if (grant && this.env.SNOWFLAKE_OAUTH_REVOCATION_URL) {
      await client(this.env).revoke({ token: grant.refreshToken ?? grant.accessToken,
        tokenTypeHint: grant.refreshToken ? "refresh_token" : "access_token" });
    }
  }

  async alarm(): Promise<void> {
    if (!this.#credentials.stored()) await this.revoke();
  }
}

/** HTTP endpoints used by the existing OS Connect popup and callback handoff. */
export async function fetchConnection(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const url = new URL(request.url);
    const base = new URL(connectionBase(env)).pathname.replace(/\/+$/, "");
    const path = url.pathname.startsWith(`${base}/`) ? url.pathname.slice(base.length) : "";
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const link = /^\/([a-f0-9]{64})\/([a-f0-9]{64})$/.exec(path);
    if (link) {
      const account = ctx.exports.SnowflakeConnection.get(ctx.exports.SnowflakeConnection.idFromString(link[1]!));
      const authorization = await account.authorize(link[2]!);
      if (!authorization) return htmlResponse(errorPageHtml("Connection expired", "Return to Cloudflare OS and connect again."), 400);
      return new Response(null, { status: 302, headers: { Location: authorization, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    if (path === "/oauth") {
      if (url.searchParams.has("error")) return htmlResponse(errorPageHtml("Authorization declined", "Return to Cloudflare OS to try again."), 400);
      const state = /^([a-f0-9]{64}):([a-f0-9]{64})$/.exec(url.searchParams.get("state") ?? "");
      const code = url.searchParams.get("code");
      if (!state || !code) return htmlResponse(errorPageHtml("Invalid callback", "Start the connection again."), 400);
      const account = ctx.exports.SnowflakeConnection.get(ctx.exports.SnowflakeConnection.idFromString(state[1]!));
      const handoff = await account.complete(code, state[2]!);
      return handoff ? htmlResponse(connectHandoffPageHtml(handoff))
        : htmlResponse(errorPageHtml("Connection expired", "Start the connection again."), 400);
    }
    return new Response("Not found", { status: 404 });
  } catch {
    // OAuth responses and callbacks can contain credential material; do not echo provider errors.
    return htmlResponse(errorPageHtml("Snowflake connection failed", "Check the application's account, role, callback URL, and OAuth settings, then connect again."), 400);
  }
}
