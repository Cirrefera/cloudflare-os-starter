import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { CredentialCoordinator, CredentialsChangedError } from "@gadgets/gatekeeper-kit/credentials";
import { ActionApplyError, ActionJournal, ActionOutcomeUnknownError, defineActions, type TaggedAction } from "@gadgets/gatekeeper-kit/actions";
import { buildDescription } from "@gadgets/gatekeeper-kit/action-description";
import { ObservationGate, trackedCollectionObservers, type ObserverStrategy } from "@gadgets/gatekeeper-kit/observers";
import type {
  AccountDescription, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUser,
  GatekeeperUserVerifier, GatekeeperConnectCallback, GatekeeperConnectOptions,
  ResourceDescription, ResourceConfiguratorFrame, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { CloudflareAccountSession, CloudflareAccountRequest, CloudflareAccountResponse, CloudflareAccountAction, CloudflareAccountActionResult } from "./types.js";
import TYPES from "./types.txt";

type AccountProps = { accountId: string };
type ConnectionRead = { generation: string; authority: string; account: string; baseUrl: string };
type NativeActions = { request: CloudflareAccountRequest };
type NativeActionHost = { execute(request: CloudflareAccountRequest, generation: string, actionId: number): Promise<void> };
const ICON = { url: "https://www.cloudflare.com/favicon.ico" };

function configuration(env: Env) {
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error("Set the CLOUDFLARE_API_TOKEN deployment secret.");
  if (!env.CLOUDFLARE_ACCOUNT_ID || !/^[a-fA-F0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID)) throw new Error("Set a valid CLOUDFLARE_ACCOUNT_ID.");
  return { token: env.CLOUDFLARE_API_TOKEN, account: env.CLOUDFLARE_ACCOUNT_ID, baseUrl: "https://api.cloudflare.com" };
}

/** Confine native requests to the fixed Cloudflare API origin and version prefix. */
function accountUrl(base: string, path: string): URL {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) throw new Error("Use a native Cloudflare API-relative path.");
  const url = new URL(`/client/v4${path}`, base);
  if (url.origin !== base || !url.pathname.startsWith("/client/v4/") || url.hash) throw new Error("Use a native Cloudflare API-relative path.");
  return url;
}
function queryPath(path: string, query?: Record<string, string>): string {
  const params = new URLSearchParams(query);
  return params.size ? `${path}?${params}` : path;
}

const ACTIONS = defineActions<NativeActionHost, NativeActions>({
  request: {
    kind: { tag: "cloudflareaccount-native-request", label: "Run native Cloudflare operation" },
    delivery: "await-decision", claimBeforeApply: true,
    describe: request => ({
      title: "Run native Cloudflare operation",
      ...buildDescription("Run this native Cloudflare request with the connected account's permissions.")
        .inline("API origin", "https://api.cloudflare.com/client/v4")
        .inline("HTTP method", request.method ?? "GET")
        .inline("API path", request.path)
        .json("Native request", request)
        .finish(),
      implementsRevert: false,
    }),
    apply: (request, host, context) => host.execute(request, context.fence!.generation, context.id),
  },
}, { fence: "authority", retainApplied: true, vendorId: "cloudflareaccount" });

/** Credential lifecycle is account-owned; only its fingerprint is retained in DO storage. */
@validateRpc()
export class CloudflareAccountConnection extends DurableObject<Env> {
  readonly #credentials = new CredentialCoordinator<string>(this.ctx.storage.kv, { vendorId: "cloudflareaccount" });
  async read(): Promise<ConnectionRead> {
    if (this.ctx.storage.kv.get<boolean>("revoked")) throw new Error("Cloudflare Account connection was revoked.");
    const config = configuration(this.env);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(config)));
    const authority = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (this.ctx.storage.kv.get<boolean>("revoked")) throw new Error("Cloudflare Account connection was revoked.");
    if (this.#credentials.stored() !== authority) this.#credentials.connect(authority);
    return { authority, generation: this.#credentials.connectionGeneration(), account: config.account, baseUrl: config.baseUrl };
  }
  async revoke(): Promise<void> {
    this.ctx.storage.kv.put("revoked", true);
    this.#credentials.clear();
  }
  async hasAuthorities(authorities: string[]): Promise<boolean[]> {
    try {
      const current = await this.read();
      return authorities.map(authority => authority === current.authority);
    } catch { return authorities.map(() => false); }
  }
  async invoke(request: CloudflareAccountRequest, expectedGeneration: string): Promise<CloudflareAccountResponse> {
    const current = await this.read();
    if (current.generation !== expectedGeneration) throw new CredentialsChangedError();
    const config = configuration(this.env);
    const url = accountUrl(config.baseUrl, request.path);
    const method = request.method ?? "GET";
    const headers = new Headers({ authorization: `Bearer ${config.token}`, accept: "application/json, text/event-stream" });
    const body = request.body;
    if ((method === "GET" || method === "HEAD") && body !== undefined) throw new Error("Native GET/HEAD requests do not accept a JSON body.");
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual" });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    // An SSE response is returned whole, including event names, ids, and every data block.
    let result: unknown = text;
    if (contentType.toLowerCase().includes("json") && text) {
      try { result = JSON.parse(text); } catch { /* Preserve malformed provider output verbatim. */ }
    }
    if ((await this.read()).generation !== expectedGeneration) throw new ActionOutcomeUnknownError("The connection changed after Cloudflare dispatch; check Cloudflare before submitting again.");
    return { status: response.status, contentType, body: result };
  }
}

/** Advertises native Cloudflare account capabilities. */
@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> {
    return { displayName: "Cloudflare Account", url: "https://www.cloudflare.com", logo: ICON,
      tagline: "Native Cloudflare account management", description: "Native Cloudflare APIs under your Cloudflare account's permissions.",
      providesAuth: false, autoProvisionsAccount: true };
  }
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    configuration(this.env);
    return this.ctx.exports.CloudflareAccountAccount({ props: { accountId: crypto.randomUUID() } });
  }
  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("Cloudflare Account uses deployment credentials; enable its auto-provisioned account.");
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
}

/** Connected account capability, scoped to one revocable connection. */
@validateRpc()
export class CloudflareAccountAccount extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  #connection() { return this.ctx.exports.CloudflareAccountConnection.getByName(this.ctx.props.accountId); }
  async describe(): Promise<AccountDescription> {
    const read = await this.#connection().read();
    return { displayName: read.account, avatar: ICON, singleton: { tsType: "CloudflareAccountSession" } };
  }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<CloudflareAccountSession>>> {
    await this.#connection().read();
    return this.ctx.exports.CloudflareAccountGatekeeper({ props: this.ctx.props });
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): Promise<{ class: DurableObjectClass<Gatekeeper<CloudflareAccountSession>>; resource: SupportedResource }> {
    throw new Error("Cloudflare Account uses the connected account's singleton binding.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("Cloudflare Account has no resource configurator."); }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> { await this.#connection().revoke(); }
  reconnect(): Promise<{ url: string }> { throw new Error("Replace the Cloudflare Account deployment credential and connect a new account."); }
  commitReconnect(_stageId: string): Promise<void> { throw new Error("Cloudflare Account has no interactive reconnect flow."); }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.CloudflareAccountVerifier({ props: this.ctx.props }); }
}

/** Collaborators prove the same native provider authority without revealing the token. */
@validateRpc()
export class CloudflareAccountVerifier extends WorkerEntrypoint<Env, AccountProps> {
  async hasAuthorities(authorities: string[]): Promise<boolean[]> {
    return this.ctx.exports.CloudflareAccountConnection.getByName(this.ctx.props.accountId).hasAuthorities(authorities);
  }
}
type Verifier = Fetcher<GatekeeperUserVerifier> & { hasAuthorities(authorities: string[]): Promise<boolean[]> };

/** Per-workspace account facet, owning observers and pending native operations. */
@validateRpc()
export class CloudflareAccountGatekeeper extends DurableObject<Env, AccountProps> implements Gatekeeper<CloudflareAccountSession> {
  readonly #journal = new ActionJournal<TaggedAction<NativeActions>>(this.ctx.storage.kv, { namespace: "cloudflareaccount-native" });
  readonly #observers = trackedCollectionObservers<Verifier>({
    kv: this.ctx.storage.kv, collectionPrefix: "cloudflareaccountAuthority:", vendorId: "cloudflareaccount",
    hasCollectionAccess: (verifier, ids) => verifier.hasAuthorities([...ids]),
  });
  readonly #host: NativeActionHost = {
    execute: async (request, generation, actionId) => {
      try {
        const read = await this.#connection().read();
        if (read.generation !== generation) throw new CredentialsChangedError();
        const response = await this.#connection().invoke(request, generation);
        this.ctx.storage.kv.put(`cloudflareaccountResult:${actionId}`, { response, authority: read.authority });
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "CredentialsChangedError") {
          throw new ActionApplyError("The Cloudflare credentials changed before dispatch; submit this request again.");
        }
        throw new ActionOutcomeUnknownError("The native Cloudflare request did not complete; check Cloudflare before submitting it again.");
      }
    },
  };
  readonly #actions = ACTIONS.bind(this.#journal, this.#host);
  #connection() { return this.ctx.exports.CloudflareAccountConnection.getByName(this.ctx.props.accountId); }
  async describe(): Promise<ResourceDescription> {
    return { url: "cloudflareaccount://account", title: "Cloudflare Account", snippet: "Native Cloudflare account management.", suggestedBindingName: "CLOUDFLARE_ACCOUNT", tsType: "CloudflareAccountSession" };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return this.#actions.autoApprovableKinds(); }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<CloudflareAccountSession> {
    const ownedQueue = queue.dup();
    return new SessionImpl(ownedQueue, this.#connection(), this.#observers,
      (request, generation) => this.#actions.submit(ownedQueue, "request", request, { fence: { generation } }),
      actionId => this.#result(actionId));
  }
  async #result(actionId: number): Promise<{ result: CloudflareAccountActionResult; authority?: string }> {
    const record = this.#journal.get(actionId);
    const stored = this.ctx.storage.kv.get<{ response: CloudflareAccountResponse; authority: string }>(`cloudflareaccountResult:${actionId}`);
    if (stored) return { result: { status: "applied", response: stored.response }, authority: stored.authority };
    if (!record) return { result: { status: this.#journal.wasApplied(actionId) ? "applied" : "unavailable" } };
    if (record.state === "failed") return { result: { status: record.outcome === "unknown" ? "unknown-outcome" : "failed", message: record.error } };
    return { result: { status: record.state === "claimed" ? "applying" : "pending" } };
  }
  async applyAction(actionId: number): Promise<void> {
    const read = await this.#connection().read();
    await this.#actions.apply(actionId, { generation: read.generation });
  }
  async rejectAction(actionId: number): Promise<void> { await this.#actions.reject(actionId); }
  revertAction(_actionId: number): Promise<void> { throw new Error("Native Cloudflare requests have no generic undo; submit the native inverse operation."); }
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> { await this.#observers.addObserver(id, user); }
  async removeObserver(id: string): Promise<void> { await this.#observers.removeObserver(id); }
}

@validateRpc()
class SessionImpl extends RpcTarget implements CloudflareAccountSession {
  readonly #observations: ObservationGate;
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #connection: DurableObjectStub<CloudflareAccountConnection>;
  readonly #submit: (request: CloudflareAccountRequest, generation: string) => Promise<number>;
  readonly #result: (actionId: number) => Promise<{ result: CloudflareAccountActionResult; authority?: string }>;
  constructor(queue: RpcStub<ApprovalQueue>, connection: DurableObjectStub<CloudflareAccountConnection>,
    observers: ObserverStrategy, submit: (request: CloudflareAccountRequest, generation: string) => Promise<number>,
    result: (actionId: number) => Promise<{ result: CloudflareAccountActionResult; authority?: string }>) {
    super();
    this.#queue = queue;
    this.#connection = connection;
    this.#submit = submit;
    this.#result = result;
    this.#observations = new ObservationGate(queue.dup(), observers);
  }
  async #assertCurrent(read: ConnectionRead): Promise<void> {
    const current = await this.#connection.read();
    if (current.generation !== read.generation || current.authority !== read.authority) throw new CredentialsChangedError();
  }
  async #observe(read: ConnectionRead, title: string): Promise<void> {
    // A revoke or credential replacement during provider I/O must fence disclosure as well as dispatch.
    await this.#assertCurrent(read);
    await this.#observations.authorize({ title, description: "Read native Cloudflare data with the connected account's permissions." }, { kind: "collections", ids: [read.authority] });
    // Authorizing an observation can itself await RPC while the account changes.
    await this.#assertCurrent(read);
  }
  async #read(request: CloudflareAccountRequest): Promise<CloudflareAccountResponse> {
    const read = await this.#connection.read();
    const response = await this.#connection.invoke(request, read.generation);
    if ((await this.#connection.read()).generation !== read.generation) throw new CredentialsChangedError();
    await this.#observe(read, "Read native Cloudflare account data");
    if ((await this.#connection.read()).generation !== read.generation) throw new CredentialsChangedError();
    return response;
  }
  async #action(request: CloudflareAccountRequest): Promise<CloudflareAccountAction> {
    const read = await this.#connection.read();
    accountUrl(read.baseUrl, request.path);
    return { actionId: await this.#submit(request, read.generation) };
  }
  async #accountPath(suffix: string): Promise<string> {
    return `/accounts/${(await this.#connection.read()).account}${suffix}`;
  }
  async getAccount(): Promise<CloudflareAccountResponse> { return this.#read({ path: await this.#accountPath("") }); }
  async listAccounts(query?: Record<string, string>): Promise<CloudflareAccountResponse> { return this.#read({ path: queryPath("/accounts", query) }); }
  async listR2Buckets(query?: Record<string, string>): Promise<CloudflareAccountResponse> { return this.#read({ path: queryPath(await this.#accountPath("/r2/buckets"), query) }); }
  async getR2Bucket(name: string): Promise<CloudflareAccountResponse> { return this.#read({ path: await this.#accountPath(`/r2/buckets/${encodeURIComponent(name)}`) }); }
  async listWorkers(query?: Record<string, string>): Promise<CloudflareAccountResponse> { return this.#read({ path: queryPath(await this.#accountPath("/workers/scripts"), query) }); }
  async getWorker(name: string): Promise<CloudflareAccountResponse> { return this.#read({ path: await this.#accountPath(`/workers/scripts/${encodeURIComponent(name)}`) }); }
  async listD1Databases(query?: Record<string, string>): Promise<CloudflareAccountResponse> { return this.#read({ path: queryPath(await this.#accountPath("/d1/database"), query) }); }
  async getD1Database(id: string): Promise<CloudflareAccountResponse> { return this.#read({ path: await this.#accountPath(`/d1/database/${encodeURIComponent(id)}`) }); }
  async listKVNamespaces(query?: Record<string, string>): Promise<CloudflareAccountResponse> { return this.#read({ path: queryPath(await this.#accountPath("/storage/kv/namespaces"), query) }); }
  async getKVNamespace(id: string): Promise<CloudflareAccountResponse> { return this.#read({ path: await this.#accountPath(`/storage/kv/namespaces/${encodeURIComponent(id)}`) }); }
  async listZones(query?: Record<string, string>): Promise<CloudflareAccountResponse> {
    const read = await this.#connection.read();
    return this.#read({ path: queryPath("/zones", { ...query, "account.id": read.account }) });
  }
  async request(request: CloudflareAccountRequest): Promise<CloudflareAccountResponse | CloudflareAccountAction> {
    const method = request.method ?? "GET";
    return method === "GET" || method === "HEAD" ? this.#read(request) : this.#action(request);
  }
  async getActionResult(actionId: number): Promise<CloudflareAccountActionResult> {
    const read = await this.#connection.read();
    const result = await this.#result(actionId);
    if (result.authority && result.authority !== read.authority) throw new CredentialsChangedError();
    await this.#observe({ ...read, authority: result.authority ?? read.authority }, "Read native Cloudflare Account operation result");
    if ((await this.#connection.read()).generation !== read.generation) throw new CredentialsChangedError();
    return result.result;
  }
  [Symbol.dispose](): void { this.#observations[Symbol.dispose](); this.#queue[Symbol.dispose](); }
}
