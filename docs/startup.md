# Build and deploy

The complete upstream OS is vendored unchanged at `cloudflare-os/`, pinned to
`5cae880e5e54563895a067e7f4dae67514e581be` (upstream `main` checked October 4, 2026).
The four custom Gatekeepers are separate packages under `packages/`.

## Install and build

Use Node 24.19+ and pnpm 11.17+:

```sh
pnpm install --frozen-lockfile
pnpm --dir cloudflare-os install --frozen-lockfile
pnpm build
```

`pnpm build` builds the entire upstream workspace, generates custom Worker runtime types,
and type-checks the four custom Gatekeepers and the existing deployment wrapper Workers.
No upstream source is patched.

## Verify

```sh
pnpm check:boundary
pnpm types:scripts
pnpm test
pnpm check:full
```

`pnpm test` runs only the tests supplied by upstream. No custom tests were added.
`pnpm check:full` runs upstream tests, builds everything, and dry-runs every upstream Worker
plus all four custom Gatekeepers using synthetic configuration. It does not deploy.
The existing example Gatekeeper and Error Reporter are also checked because the wrapper uses them.
After the upstream suites pass, `pnpm check:full -- --skip-tests` repeats only the build and dry runs.
See [build-status.md](build-status.md) for the completed verification and container-specific settings.

## Configure and deploy

`deployment.jsonc` preserves the existing account, sign-in, route, and storage settings.
The four custom Gatekeepers are enabled there. Stock optional integrations are all wired;
set their `enabled` and `workerName` when installing them. Their OAuth credentials or endpoint
configuration remain required, just as upstream requires them.

| Custom package | Required secrets | Configuration |
| --- | --- | --- |
| `gatekeeper-snowflake` | `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_ROLE`, `CLIENT_ID`, `CLIENT_SECRET` | Browser OAuth; approved writes use the connected grant and operator flag. |
| `gatekeeper-huggingface` | None | Browser OAuth through public CIMD metadata; select a repository in the OS. |
| `gatekeeper-cloudflareaccount` | `CLOUDFLARE_API_TOKEN` | `CLOUDFLARE_ACCOUNT_ID` is supplied from the deployment account ID. |
| `gatekeeper-alphaxiv` | None | Public research reads only. |

Supply secrets through the existing Wrangler workflow or ignored
`.secrets/<workerName>.json` files described in [deployment-secrets.md](deployment-secrets.md).
Do not put credentials in tracked files.

After authentication and credential configuration:

```sh
pnpm check
pnpm deploy
# For a first deployment using the ignored secret files:
pnpm deploy -- --with-secrets
```

Cloudflare Account and AlphaXiv are private service bindings, with no public HTTP route.
The Router remains the public entry point. Deployments run the Gatekeepers before the Workshop,
and the Router last. Local builds and dry runs do not prove live provider permissions.

Snowflake now connects interactively. See [Snowflake OAuth setup](../packages/gatekeeper-snowflake/README.md) for the registered callback and application setup.

For Windows browser login and deployment, use [the local script](local-deployment.md).
