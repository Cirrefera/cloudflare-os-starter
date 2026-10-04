# Snowflake connection

Snowflake is connected from the OS **Connectors** page through its normal browser authorization
handshake. The custom package uses the upstream Gatekeeper Kit for OAuth, nonces, popup handoff,
credential storage/refresh, expiry notifications, and staged reconnects. No managed MCP server
is needed for its existing native SQL, Analyst, Search, and approved-write methods.

## One-time application setup

In Snowsight, an administrator creates a confidential OAuth integration. Register this
callback for the current deployment:

`https://hellgate-os-router.mchayes89.workers.dev/gatekeeper/snowflake/oauth`

Example SQL (run in your account; this project has not executed it):

```sql
CREATE SECURITY INTEGRATION CLOUDFLARE_OS_SNOWFLAKE_OAUTH
  TYPE = OAUTH
  ENABLED = TRUE
  OAUTH_CLIENT = CUSTOM
  OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
  OAUTH_REDIRECT_URI = 'https://hellgate-os-router.mchayes89.workers.dev/gatekeeper/snowflake/oauth'
  OAUTH_ENFORCE_PKCE = TRUE
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 86400;

SELECT SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('CLOUDFLARE_OS_SNOWFLAKE_OAUTH');
```

Install these four application settings in the Worker's ignored credential file:
`.secrets/hellgate-os-gatekeeper-snowflake.json`:

```json
{
  "SNOWFLAKE_ACCOUNT": "organization-account",
  "SNOWFLAKE_ROLE": "YOUR_APPLICATION_ROLE",
  "CLIENT_ID": "<OAUTH_CLIENT_ID>",
  "CLIENT_SECRET": "<OAUTH_CLIENT_SECRET>"
}
```

The account identifier is the account hostname before `.snowflakecomputing.com`. The configured
role must be granted to every user who is allowed to connect and have access to the intended
SQL/Cortex resources. Use a regular application role; Snowflake blocks privileged roles in
OAuth by default. The Worker requests `session:role:<configured role>` plus refresh-token scope.
`BASE_URL` is generated from the Router URL. For a different hostname, register its exact callback.

These are application credentials. The gatekeeper obtains each human's access/refresh tokens
from Snowflake after login and consent; a manually supplied `SNOWFLAKE_TOKEN` is no longer used.

## User flow

1. Enable the Snowflake connector in the OS admin settings if necessary.
2. Open **Connectors**, choose **Snowflake**, and select **Connect**.
3. Sign into Snowflake, authorize the configured role, and return to the OS.
4. The connected account exposes its existing typed `SnowflakeSession` capability.

Reconnect repeats consent for the original Snowflake user and activates the new grant only
after the OS confirms the browser handoff. Connecting a different user requires a separate
connection. Disconnect removes local credentials immediately, so existing bindings stop working.
Provider-side revocation is attempted only when the operator supplies a supported
`SNOWFLAKE_OAUTH_REVOCATION_URL`; no undocumented endpoint is assumed.

Tokens are refreshed through the upstream coordinator. Confirmed expiry is reported to the OS.
Every provider request reads the connected account's current grant. Queued writes carry the
connection generation and refuse execution after reconnect/disconnect; approved plans retain
the existing operator gate, policy checks, and execution journal. Writes use the user's grant,
not a shared write token. Any write-role override must be usable under that OAuth grant.

Existing allowlists, warehouse settings, limits, and write switch still apply. Cortex Agent
execution and generic custom-tool execution remain disabled as in the previous implementation.
Old auto-provisioned bindings need a new interactive Snowflake connection.

## Verification

Only upstream tests are used. Type checking, the complete Worker build, deployment dry runs,
and upstream Gatekeeper Kit tests are the local checks. A live login needs the registered
application and a deployed callback; local checks do not prove account-specific permissions.
