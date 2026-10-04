# Snowflake connection review — October 4, 2026

## Recommendation

For the browser connection experience discussed in this chat, preserve the existing custom
Snowflake package and its typed SQL/Cortex/approved-write methods. Add a per-user Snowflake OAuth
connection using the existing upstream Gatekeeper Kit. This is the smallest feature-preserving
route: it avoids an extra MCP server and keeps upstream OS files unchanged.

This was the recommendation from the source review. The subsequent implementation now opens
interactive OAuth in the custom Snowflake worker; see its README. A live connection remains
unverified. The implementation-status bullets below record the state at review time. No accounts were contacted and no new tests were built or run during this review.

## What is already implemented

- The OS supports normal Connect / browser authorization / callback handoffs. The shared kit
  supports registered OAuth clients, PKCE, authorization-code exchange, refresh, revocation,
  staged reconnects, and credential lifecycle helpers.
- Custom Snowflake is enabled and wired into Workshop and Router. It calls Snowflake's SQL,
  Cortex Analyst, and Cortex Search REST APIs directly. Metadata, bounded/paged read-only SQL,
  configured Cortex resources, and governed write machinery exist.
- Its current `connectAccount()` and reconnect methods throw. Credentials come from deployment
  environment; revoke is empty. Browser per-user authentication is not implemented there.
- Cortex Agent execution and custom-tool execution are explicitly disabled. These are separate
  feature gaps; finishing authentication alone would not make those methods functional.
- The upstream ordinary MCP connector already supports Streamable HTTP, discovery, tools,
  OAuth callbacks, token refresh, and scoped tool selection. It is wired but disabled in the
  operator configuration.

## Snowflake documentation findings

1. The pasted MCP Connectors guide describes Cortex Agents / CoWork consuming external MCP
   servers. It supports registered OAuth apps or dynamic client registration when supported by
   the external provider. It is not documentation of authentication into Snowflake itself.
2. Snowflake's managed MCP server is a separate supported product exposing Snowflake tools.
   The official quickstart shows Analyst, Search, SQL execution, and generic procedure tools.
   Another official quickstart exposes a Cortex Agent.
3. Official managed-MCP OAuth examples create a Snowflake `SECURITY INTEGRATION` with
   `OAUTH_CLIENT = CUSTOM`, a registered redirect URI, and client ID/secret. The inspected
   OpenAI SDK example uses a confidential client and issues refresh tokens. Its browser flow
   obtains the human's access token after consent.
4. Managed-MCP quickstarts also demonstrate PAT bearer authentication. This is an available
   operator choice, not evidence that browser authorization is impossible or that personal
   tokens must be collected as the normal connection experience.
5. The old Snowflake-Labs community MCP server is deprecated and directs users to the official
   managed server. Deploying it would add infrastructure without resolving our goal.

## Compatibility detail that prevents a configuration-only shortcut

The OS's ordinary MCP connector dynamically registers a public client (`none` client auth).
It does not accept a configured, pre-registered OAuth client ID/secret. Its own README describes
registration failures for providers without DCR. The current repo's Snowflake design also
records the registered-client requirement.

Therefore, simply enabling `mcpv2` and pasting a Snowflake managed-MCP URL is not an established
working path. A registered-client auth adapter is required for the documented Snowflake setup.
The portal's static token option is not a direct workaround: it requires portal-specific server
listing and prefixed-tool behavior that a plain MCP endpoint does not implement.

## Courses of action

| Route | Work and setup | Fit |
| --- | --- | --- |
| Keep native Snowflake, add registered OAuth with the existing kit | One-time Snowflake OAuth application setup; per-user connection/token lifecycle; existing resource grants and policies | Recommended when preserving current custom methods and governed writes |
| Use Snowflake managed MCP with a registered-client adapter | OAuth setup plus a managed MCP server; reuse MCP transport/session/discovery; reconcile typed methods and custom policies | Prefer when the desired functionality is fully exposed by the managed server |
| Keep deployment bearer credentials | Current implementation already uses this | Operator-managed option; does not provide the requested browser handshake |

The native OAuth change is more than replacing the throwing `connectAccount()` method: API calls
must use each connected account's credentials, refresh/revoke/reconnect must be implemented, and
resource bindings/actions must remain attached to that account. Reuse the kit rather than
writing a new OAuth protocol. No personal `SNOWFLAKE_TOKEN` should be the default input for this
browser-auth route.

For that recommended route, admin setup inputs are the Snowflake account URL, application
client ID/secret, registered OS callback URL, and intended role/resource grants. Users then
sign in and authorize through Snowflake. Access and refresh tokens are obtained by the Worker.
These inputs are prospective requirements, not a request to supply them during this review.

## Evidence

Local source:

- `packages/gatekeeper-snowflake/src/snowflake.ts:71`: native bearer REST client.
- `packages/gatekeeper-snowflake/src/snowflake.ts:159`: account provisioning and disabled connect.
- `packages/gatekeeper-snowflake/src/snowflake.ts:171`: disabled reconnect / empty revoke.
- `packages/gatekeeper-snowflake/src/snowflake.ts:543`: disabled Agent / custom tools.
- `docs/snowflake-gatekeeper.md:119`: intended OAuth and managed-MCP design; not runtime proof.
- `cloudflare-os/packages/gatekeeper-kit/src/oauth-client.ts:60`: registered-client auth types.
- `cloudflare-os/packages/mcp-shared/src/account.ts:498`: dynamic public-client registration.
- `cloudflare-os/packages/gatekeeper-mcp/README.md:86`: actual MCP connection flow and DCR limit.
- `cloudflare-os/packages/gatekeeper-mcp-portal/README.md:127`: portal contract.

Public sources read:

- [User-provided MCP Connectors documentation](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents-mcp-connectors).
- [Official managed-MCP quickstart source](https://github.com/Snowflake-Labs/sfquickstarts/blob/b893fe5fd5c8c9c6ff6befdd9835f7a48384c9dd/site/sfguides/src/getting-started-with-snowflake-mcp-server/getting-started-with-snowflake-mcp-server.md).
- [Official managed-MCP browser OAuth example](https://github.com/Snowflake-Labs/sfquickstarts/blob/b893fe5fd5c8c9c6ff6befdd9835f7a48384c9dd/site/sfguides/src/get-started-with-openai-sdk-and-managed-mcp-for-cortex-agents/get-started-with-openai-sdk-and-managed-mcp-for-cortex-agents.md). Its linked ZIP includes the OAuth security integration SQL inspected in this review.
- [Official Amazon Quick OAuth walkthrough](https://github.com/Snowflake-Labs/sfquickstarts/blob/b893fe5fd5c8c9c6ff6befdd9835f7a48384c9dd/site/sfguides/src/build-conversational-analytics-with-amazon-quick-and-snowflake-mcp/build-conversational-analytics-with-amazon-quick-and-snowflake-mcp.md).
- [Snowflake-Labs community MCP deprecation](https://github.com/Snowflake-Labs/mcp/blob/main/README.md).

Exa tools are unavailable in this session. Direct Snowflake documentation access returned 403;
this review used the user's full pasted guide and official Snowflake-Labs quickstart sources
from GitHub. The quickstarts snapshot is `b893fe5fd5c8c9c6ff6befdd9835f7a48384c9dd`, dated
October 2, 2026. No claim of live endpoint interoperability has been made.
