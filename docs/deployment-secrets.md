# First-deploy secrets

Secrets are installed per Worker, from operator-supplied files, through the installed Wrangler —
never through shell arguments, never in one combined file, never inside the repository.

## The operator source

Create one JSON file per Worker in `.secrets/` (gitignored at the repository root):

```
.secrets/<workerName>.json        e.g. .secrets/gatekeeper-snowflake.json
```

Each file is a flat map of secret name to value:

```json
{
  "SNOWFLAKE_ACCOUNT": "myorg",
  "CLIENT_ID": "<OAuth application client ID>",
  "CLIENT_SECRET": "<OAuth application client secret>",
  "SNOWFLAKE_ROLE": "READER_ROLE"
}
```

## The contract

Each Worker receives **only its own credentials**. The contract comes from the deployment
configuration:

| Worker | Required secrets |
| --- | --- |
| workshop | `CF_AI_GATEWAY_API_TOKEN`, only when the AI Gateway plan needs a token |
| gatekeeper-snowflake | `SNOWFLAKE_ACCOUNT`, `SNOWFLAKE_ROLE`, `CLIENT_ID`, `CLIENT_SECRET` |
| gatekeeper-huggingface | None (browser OAuth) |
| gatekeeper-cloudflareaccount | `CLOUDFLARE_API_TOKEN` |
| gatekeeper-alphaxiv | None; its source file is `{}` |

Validation is strict and fails **before** anything is installed:

- **Completeness** — every required secret must be present and non-empty.
- **Isolation** — names outside the Worker's contract are refused. A Hugging Face token can never
  ride the Snowflake Worker's file, and vice versa.

## Snowflake authorization

Snowflake uses its registered OAuth application's `CLIENT_ID` / `CLIENT_SECRET`. Each human
signs in and consents through Snowflake; the gatekeeper obtains and refreshes that user's tokens.
See [Snowflake connection setup](../packages/gatekeeper-snowflake/README.md).

Approved writes require the operator's `SNOWFLAKE_ENABLE_WRITES` switch and privileges in the
connected user's OAuth grant. A separate deployment write token is not required in this flow.

## Installing

```sh
# Validate every Worker's contract without installing anything (no values loaded past validation):
node scripts/deploy.ts --check --with-secrets

# Install before (or between) deploys:
node scripts/deployment-secrets.ts ... via: node scripts/deploy.ts --with-secrets
```

`--with-secrets` on a real deploy installs the contracted secrets **before** the Workers deploy
(draft Workers receive their credentials first, so a first deploy succeeds). Values are written to
one temporary file per Worker **outside the repository** (OS temp directory), restricted to the
current user (mode `0600` on POSIX; on Windows the user-scoped `%TEMP%` ACL applies and a
read-only attribute is set best-effort), handed to the installed Wrangler's
`wrangler secret bulk <file> --name <worker>`, and **removed in `finally`** — including on
validation or deploy failures.

### After a hard kill

If the process is terminated hard enough to skip `finally`, leftover files live only in the OS
temp directory (never the repository) under a `cfos-secrets-` prefix. Remove them manually:

```powershell
# Windows (PowerShell)
Get-ChildItem $env:TEMP -Filter "cfos-secrets-*" -Directory | Remove-Item -Recurse -Force
```

```sh
# Linux
rm -rf "${TMPDIR:-/tmp}"/cfos-secrets-*
```

Dry runs (`--check`) validate the contracts and install nothing.

## Prepared credential drop location

The ignored directory `.secrets/` contains blank, restricted-permission templates named for
this deployment's actual Workers. Fill in the quoted empty values:

- `cloudflare-deploy.env`: Wrangler deployment token (`CLOUDFLARE_API_TOKEN`). Load it in
  the local deployment shell with `source .secrets/cloudflare-deploy.env`, or use Wrangler login.
- `hellgate-os-gatekeeper-cloudflareaccount.json`: account-integration API token.
- `hellgate-os-gatekeeper-snowflake.json`: account identifier, role, OAuth application client ID and secret.
- `hellgate-os-gatekeeper-huggingface.json`: keep `{}`; Hugging Face uses browser OAuth.
- `hellgate-os-gatekeeper-alphaxiv.json`: keep `{}`; AlphaXiv needs no key.

The deployment token and the Cloudflare Account integration token are separate inputs.
The integration token needs the permissions for the Cloudflare operations you intend to use.
The current same-account Workers AI configuration needs no additional model-provider key.
Completing these files does not install credentials or deploy Workers.
