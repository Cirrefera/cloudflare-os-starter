# Hugging Face gatekeeper

Connect from Cloudflare OS through Hugging Face browser login and consent. The worker publishes
its public OAuth Client ID Metadata Document at `BASE_URL/.well-known/oauth-cimd`, uses that URL
as its client ID, and exchanges authorization codes with PKCE. No personal token or app secret
is needed. The metadata URL must be publicly reachable by Hugging Face, including through any
Cloudflare Access rules. Router service wiring already forwards this endpoint and the `/oauth`
callback to this worker.

The upstream Gatekeeper Kit handles initiation/state expiry, credential storage, refresh when
issued, reconnect staging, expiry notification, and callback handoff. Grants without refresh
tokens reconnect through the browser when they expire. Disconnect invalidates local access;
provider consent can also be withdrawn in Hugging Face Connected Applications.

Choose a model, dataset, or Space repository in the existing OS resource selection form.
Connected-user grants back repository reads, dataset queries, bounded file reads and inference.
Write proposals retain the existing approval flow, require operator `HF_ENABLE_WRITES=true`,
and are bound to the connection generation that proposed them. Reconnecting requires fresh
proposals. Writes request the additional repository/discussion OAuth scopes only when enabled.

Official protocol documentation: https://huggingface.co/docs/hub/oauth
