import { DurableObject, RpcTarget, WorkerEntrypoint, type RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { ObservationGate, openObservers } from "@gadgets/gatekeeper-kit/observers";
import type {
  AccountDescription, ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUser,
  GatekeeperUserVerifier, GatekeeperConnectCallback, GatekeeperConnectOptions, ResourceDescription, ResourceConfiguratorFrame, SupportedResource, VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { AlphaXivSession } from "./types.js";
import TYPES from "./types.txt";

type AccountProps = { accountId: string };
const ICON = { url: "https://www.alphaxiv.org/favicon.ico" };
const OBSERVERS = openObservers();

/** This binding reads public papers only, so shared observations have no private-paper ACL. */
function publicPaperId(value: string): string {
  const url = new URL(value);
  const arxiv = url.hostname === "arxiv.org" || url.hostname === "www.arxiv.org";
  const alphaxiv = url.hostname === "alphaxiv.org" || url.hostname === "www.alphaxiv.org";
  const id = "(?:[0-9]{4}\\.[0-9]{4,5}|[a-zA-Z.-]+/[0-9]{7})(?:v[0-9]+)?";
  const path = new RegExp(`^/(?:${arxiv ? "abs|pdf|html" : "abs|overview"})/${id}(?:\\.pdf)?/?$`);
  if (url.protocol !== "https:" || url.username || url.password || url.port
      || !(arxiv || alphaxiv) || !path.test(url.pathname)) {
    throw new Error("Use a public arXiv or AlphaXiv paper URL, not a private upload identifier.");
  }
  return url.pathname.replace(/^\/(?:abs|pdf|html|overview)\//, "").replace(/\/$/, "").replace(/\.pdf$/, "");
}

/** Per-connection revocation state for the public research capability. */
@validateRpc()
export class AlphaXivConnection extends DurableObject<Env> {
  async checkActive(): Promise<void> {
    if (await this.ctx.storage.get<boolean>("revoked")) throw new Error("AlphaXiv connection was revoked.");
  }
  async revoke(): Promise<void> { await this.ctx.storage.put("revoked", true); }
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "AlphaXiv", url: "https://www.alphaxiv.org", logo: ICON,
      tagline: "Discover and read research papers",
      description: "Read-only public paper discovery and paper content.",
      autoProvisionsAccount: true, providesAuth: false,
    };
  }
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.AlphaXivAccount({ props: { accountId: crypto.randomUUID() } });
  }
  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> { throw new Error("AlphaXiv public research uses its auto-provisioned account."); }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
}

@validateRpc()
export class AlphaXivAccount extends WorkerEntrypoint<Env, AccountProps> implements GatekeeperUser {
  #connection() { return this.ctx.exports.AlphaXivConnection.getByName(this.ctx.props.accountId); }
  async describe(): Promise<AccountDescription> {
    await this.#connection().checkActive();
    return { displayName: "AlphaXiv", avatar: ICON, singleton: { tsType: "AlphaXivSession" } };
  }
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<AlphaXivSession>>> {
    await this.#connection().checkActive();
    return this.ctx.exports.AlphaXivGatekeeper({ props: this.ctx.props });
  }
  async getSupportedResources(): Promise<SupportedResource[]> { return []; }
  getGatekeeperClassFor(_url: string): Promise<{ class: DurableObjectClass<Gatekeeper<AlphaXivSession>>; resource: SupportedResource }> { throw new Error("AlphaXiv research uses its singleton binding."); }
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> { throw new Error("AlphaXiv has no resource configurator."); }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> { return {}; }
  async revoke(): Promise<void> { await this.#connection().revoke(); }
  reconnect(): Promise<{ url: string }> { throw new Error("Connect a new AlphaXiv public research account."); }
  commitReconnect(_stageId: string): Promise<void> { throw new Error("AlphaXiv has no interactive reconnect flow."); }
  async getAuthenticatedEmail(): Promise<null> { return null; }
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> { return this.ctx.exports.AlphaXivVerifier({}); }
}

/** Public research data has no user-specific access distinction. */
@validateRpc()
export class AlphaXivVerifier extends WorkerEntrypoint<Env> {
  /** Public research is available to every observer. */
  verify(): void {}
}

@validateRpc()
export class AlphaXivGatekeeper extends DurableObject<Env, AccountProps> implements Gatekeeper<AlphaXivSession> {
  async describe(): Promise<ResourceDescription> {
    return { url: "alphaxiv://research", title: "AlphaXiv", snippet: "Discover and read public research papers.", suggestedBindingName: "ALPHAXIV", tsType: "AlphaXivSession" };
  }
  async getTypeScriptTypes(): Promise<string> { return TYPES; }
  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }
  async startSession(queue: RpcStub<ApprovalQueue>): Promise<AlphaXivSession> {
    return new AlphaXivSessionImpl(queue.dup(), this.ctx.exports.AlphaXivConnection.getByName(this.ctx.props.accountId));
  }
  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> { await OBSERVERS.addObserver(id, user); }
  async removeObserver(id: string): Promise<void> { await OBSERVERS.removeObserver(id); }
  applyAction(_actionId: number): Promise<void> { throw new Error("AlphaXiv research is read-only."); }
  rejectAction(_actionId: number): Promise<void> { throw new Error("AlphaXiv research is read-only."); }
  revertAction(_actionId: number): Promise<void> { throw new Error("AlphaXiv research is read-only."); }
}

@validateRpc()
class AlphaXivSessionImpl extends RpcTarget implements AlphaXivSession {
  readonly #observations: ObservationGate;
  readonly #connection: DurableObjectStub<AlphaXivConnection>;
  constructor(queue: RpcStub<ApprovalQueue>, connection: DurableObjectStub<AlphaXivConnection>) {
    super();
    this.#connection = connection;
    this.#observations = new ObservationGate(queue, OBSERVERS);
  }
  async #text(url: string): Promise<string> {
    const response = await fetch(url, { headers: { accept: "text/markdown, application/json, text/plain" }, redirect: "manual" });
    if (!response.ok) throw new Error(`AlphaXiv research request failed (${response.status}).`);
    if ((response.headers.get("content-type") ?? "").includes("text/html")) throw new Error("AlphaXiv returned a webpage instead of research data.");
    return response.text();
  }
  async #observe(name: string): Promise<void> {
    // Revocation is checked again before disclosing an in-flight public read.
    await this.#connection.checkActive();
    await this.#observations.authorize({ title: `AlphaXiv ${name}`, description: "Read public research papers with AlphaXiv." }, { kind: "baseline" });
    await this.#connection.checkActive();
  }
  async discover_papers(input: Parameters<AlphaXivSession["discover_papers"]>[0]): Promise<string> {
    await this.#connection.checkActive();
    const url = new URL("https://api.alphaxiv.org/v1/search/paper");
    url.searchParams.set("q", [...input.keywords, input.question].filter(Boolean).join(" "));
    url.searchParams.set("linkBlogs", "true");
    const result = await this.#text(url.href);
    await this.#observe("discover_papers");
    return result;
  }
  async get_paper_content(input: Parameters<AlphaXivSession["get_paper_content"]>[0]): Promise<string> {
    await this.#connection.checkActive();
    const paperId = publicPaperId(input.url);
    const fullTextUrl = `https://www.alphaxiv.org/abs/${paperId}.md`;
    let result: string;
    if (input.fullText) result = await this.#text(fullTextUrl);
    else {
      const response = await fetch(`https://www.alphaxiv.org/overview/${paperId}.md`, { headers: { accept: "text/markdown" }, redirect: "manual" });
      if (response.status === 404 || response.status === 204) {
        await response.body?.cancel();
        result = await this.#text(fullTextUrl);
      } else {
        if (!response.ok) throw new Error(`AlphaXiv overview request failed (${response.status}).`);
        if ((response.headers.get("content-type") ?? "").includes("text/html")) {
          await response.body?.cancel();
          result = await this.#text(fullTextUrl);
        } else result = await response.text();
      }
    }
    await this.#observe("get_paper_content");
    return result;
  }
  [Symbol.dispose](): void { this.#observations[Symbol.dispose](); }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("AlphaXiv Gatekeeper worker is running.", { headers: { "content-type": "text/plain" } });
  },
};
