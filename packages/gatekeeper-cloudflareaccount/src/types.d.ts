/** Native Cloudflare API request; credentials are added by the connection. */
export interface CloudflareAccountRequest {
  path: string;
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  body?: unknown;
}
/** Native status and decoded provider response. */
export interface CloudflareAccountResponse { status: number; contentType: string; body: unknown; }
/** Approval queue action identifier. */
export interface CloudflareAccountAction { actionId: number; }
/** Durable action outcome; ambiguous dispatch must be reconciled with Cloudflare. */
export interface CloudflareAccountActionResult {
  status: "applied" | "unavailable" | "unknown-outcome" | "failed" | "applying" | "pending";
  response?: CloudflareAccountResponse;
  message?: string;
}
/** Native API reads and queued operations for the connected account. */
export interface CloudflareAccountSession {
  getAccount(): Promise<CloudflareAccountResponse>;
  listAccounts(query?: Record<string, string>): Promise<CloudflareAccountResponse>;
  listR2Buckets(query?: Record<string, string>): Promise<CloudflareAccountResponse>;
  getR2Bucket(name: string): Promise<CloudflareAccountResponse>;
  listWorkers(query?: Record<string, string>): Promise<CloudflareAccountResponse>;
  getWorker(name: string): Promise<CloudflareAccountResponse>;
  listD1Databases(query?: Record<string, string>): Promise<CloudflareAccountResponse>;
  getD1Database(id: string): Promise<CloudflareAccountResponse>;
  listKVNamespaces(query?: Record<string, string>): Promise<CloudflareAccountResponse>;
  getKVNamespace(id: string): Promise<CloudflareAccountResponse>;
  listZones(query?: Record<string, string>): Promise<CloudflareAccountResponse>;
  request(request: CloudflareAccountRequest): Promise<CloudflareAccountResponse | CloudflareAccountAction>;
  getActionResult(actionId: number): Promise<CloudflareAccountActionResult>;
}
