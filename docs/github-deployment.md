# Deploy through GitHub Actions

The `codex/recovery-20261004` branch preserves the complete current upstream source and
the four custom gatekeepers. It can be cloned from GitHub without using ChatGPT downloads.
The recovery workflow runs on pushes to this branch. A push without deployment credentials
preserves source and exits successfully without installing anything or deploying Workers.

To configure deployment, open this repository's GitHub **Settings > Secrets and variables >
Actions > New repository secret**. Name it `CFOS_DEPLOY_CREDENTIALS` and paste one JSON object
with these six fields:

```json
{
  "CLOUDFLARE_API_TOKEN": "Cloudflare deployment token",
  "SNOWFLAKE_ACCOUNT": "MMVDVTK-DW81715",
  "SNOWFLAKE_ROLE": "CLOUDFLARE_OS_ROLE",
  "SNOWFLAKE_CLIENT_ID": "Existing Snowflake OAuth client ID",
  "SNOWFLAKE_CLIENT_SECRET": "Existing Snowflake OAuth client secret",
  "CLOUDFLARE_ACCOUNT_GATEKEEPER_TOKEN": "Cloudflare Account integration token"
}
```

The cloud workspace has prepared this input in the ignored
`.secrets/github-actions-deploy.json` file using credentials already supplied. Never commit
that file. All credential values are masked before the deployment subprocesses run.

After saving the repository secret, push another commit to the recovery branch, or rerun the
initial recovery workflow using GitHub's **Re-run all jobs** action. When the workflow is also
available on the default branch, **Run workflow** can select the recovery branch directly.

The GitHub runner installs both pinned workspaces, verifies the unchanged upstream tree,
runs only existing upstream tests, checks every Worker bundle, authenticates to Cloudflare,
installs isolated per-Worker secrets, and deploys the configured graph. Production deployments
run sequentially. No credentials are included in source, and no Hugging Face credential is
required for this deployment route. Connect Snowflake and Hugging Face through the OS's
browser consent flow after deployment.

GitHub Actions must be enabled for the repository. Runner access, secret configuration,
Cloudflare token permissions, live deployment and browser consent are not established by
local build checks or a successful Git push.
