import { readTextCapped } from "@gadgets/gatekeeper-kit/response-body";
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

type Grant = OAuthGrant & { user: string; subject: string };
type Attempt = { verifier: string; generation: string; reconnect: boolean };
type ReconnectGrant = { grant: Grant; generation: string };

/** The private credential projection used by Hugging Face API calls; refresh tokens stay in the DO. */
export type HuggingFaceCredential = { accessToken: string };

/** Router-mounted URL; its public metadata document is the OAuth client ID. */
export function connectionBase(env: Env): string {
  if (!env.BASE_URL) throw new Error("Configure the Hugging Face gatekeeper BASE_URL.");
  const url = new URL(env.BASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Hugging Face browser OAuth requires a public HTTPS gatekeeper URL.");
  }
  return url.href.replace(/\/+$/, "");
}

function client(env: Env): OAuthClient {
  return new OAuthClient({
    label: "Hugging Face",
    client: { method: "none", id: `${connectionBase(env)}/.well-known/oauth-cimd` },
    authorizationEndpoint: "https://huggingface.co/oauth/authorize",
    tokenEndpoint: "https://huggingface.co/oauth/token",
    defaultExpiresIn: 8 * 60 * 60,
  });
}

/** One human's HuggingFace connection, using the upstream credential and connection primitives. */
@validateRpc()
export class HuggingFaceConnection extends DurableObject<Env> {
  readonly #credentials = new CredentialCoordinator<Grant>(this.ctx.storage.kv, {
    expiresAt: grant => grant.expiresAt, vendorId: "huggingface",
  });

  #refresh() {
    return oauthRefresh<Grant>(client(this.env), {
      refreshToken: grant => grant.refreshToken, merge: mergeOAuthTokens,
      expiredMessage: "Reconnect your Hugging Face account.",
    });
  }

  #notify() {
    return notifyCredentialsExpiredOnce(this.ctx.storage.kv,
      this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback"), "huggingface");
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
    if (!this.ctx.storage.kv.get("callback")) throw new Error("Start a new HuggingFace connection.");
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
      scopes: ["openid", "profile", "read-repos", "gated-repos", "inference-api",
        ...(["true", "1"].includes(this.env.HF_ENABLE_WRITES ?? "") ? ["write-repos", "write-discussions", "manage-repos"] : [])], codeChallenge: pkce.codeChallenge,
    }).toString();
  }

  async complete(code: string, state: string): Promise<ConnectHandoff | null> {
    const attempt = claimOAuth<Attempt>(this.ctx.storage.kv, state, Date.now());
    if (attempt === null) return null;
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) throw new Error("Start a new HuggingFace connection.");
    const tokens = await client(this.env).exchangeCode({
      code, codeVerifier: attempt.verifier, redirectUri: `${connectionBase(this.env)}/oauth`,
    });
    // Confirm identity with the provider; do not trust an unsigned ID-token payload.
    const response = await fetch("https://huggingface.co/oauth/userinfo", {
      redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Hugging Face could not verify this user (HTTP ${response.status}).`);
    const identity = JSON.parse(await readTextCapped(response, 64 * 1024)) as { sub?: string; preferred_username?: string };
    if (!identity.sub || typeof identity.sub !== "string") throw new Error("Hugging Face did not return a user identity.");
    const grant: Grant = { ...tokens, subject: identity.sub, user: identity.preferred_username || identity.sub };
    if (this.#credentials.connectionGeneration() !== attempt.generation) throw new Error("This connection changed; start again.");
    if (attempt.reconnect) {
      if (this.#credentials.stored()?.subject !== grant.subject) throw new Error("Reconnect using the original Hugging Face user, or add a separate connection.");
      const stageId = stageCredentials(this.ctx.storage.kv, { grant, generation: attempt.generation }, Date.now());
      return callback.reconnectComplete(stageId);
    }
    this.#credentials.connect(grant, { ifGeneration: attempt.generation });
    const connectedGeneration = this.#credentials.connectionGeneration();
    try {
      // The account implements GatekeeperUser; narrowing this factory avoids recursively mapping
      // its HuggingFace session through both the loopback and callback RPC type transformations.
      const mintAccount = this.ctx.exports.HuggingFaceAccount as unknown as
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
    if (!staged) throw new Error("The HuggingFace reconnect expired; start again.");
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
    this.#credentials.clear();
    discardStagedCredentials(this.ctx.storage.kv);
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("callback");
    await this.ctx.storage.deleteAlarm();
    // Local disconnect immediately invalidates every capability. HF does not document an
    // RFC 7009 endpoint here; users may also withdraw consent in HF Connected Applications.
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
    if (path === "/.well-known/oauth-cimd") {
      return Response.json({
        client_id: `${connectionBase(env)}/.well-known/oauth-cimd`,
        client_name: "Cloudflare OS — Hugging Face",
        redirect_uris: [`${connectionBase(env)}/oauth`],
        token_endpoint_auth_method: "none",
        client_uri: new URL(connectionBase(env)).origin,
      }, { headers: { "Cache-Control": "public, max-age=300" } });
    }
    const link = /^\/([a-f0-9]{64})\/([a-f0-9]{64})$/.exec(path);
    if (link) {
      const account = ctx.exports.HuggingFaceConnection.get(ctx.exports.HuggingFaceConnection.idFromString(link[1]!));
      const authorization = await account.authorize(link[2]!);
      if (!authorization) return htmlResponse(errorPageHtml("Connection expired", "Return to Cloudflare OS and connect again."), 400);
      return new Response(null, { status: 302, headers: { Location: authorization, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    }
    if (path === "/oauth") {
      if (url.searchParams.has("error")) return htmlResponse(errorPageHtml("Authorization declined", "Return to Cloudflare OS to try again."), 400);
      const state = /^([a-f0-9]{64}):([a-f0-9]{64})$/.exec(url.searchParams.get("state") ?? "");
      const code = url.searchParams.get("code");
      if (!state || !code) return htmlResponse(errorPageHtml("Invalid callback", "Start the connection again."), 400);
      const account = ctx.exports.HuggingFaceConnection.get(ctx.exports.HuggingFaceConnection.idFromString(state[1]!));
      const handoff = await account.complete(code, state[2]!);
      return handoff ? htmlResponse(connectHandoffPageHtml(handoff))
        : htmlResponse(errorPageHtml("Connection expired", "Start the connection again."), 400);
    }
    return new Response("Not found", { status: 404 });
  } catch {
    // OAuth responses and callbacks can contain credential material; do not echo provider errors.
    return htmlResponse(errorPageHtml("HuggingFace connection failed", "Check that this gatekeeper's public OAuth metadata and callback URL are reachable, then connect again."), 400);
  }
}
