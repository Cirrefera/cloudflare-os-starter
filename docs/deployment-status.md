# Deployment status — October 4, 2026

The complete upstream source is pinned to official `main` at
`5cae880e5e54563895a067e7f4dae67514e581be`, with Snowflake, Hugging Face,
Cloudflare Account, and AlphaXiv wired into the deployment.

The full build, existing upstream tests, and all 24 Worker dry runs passed in
[the corrected workflow](https://github.com/Cirrefera/cloudflare-os-starter/actions/runs/37230015487).
The deployment then failed at its first secret upload. Direct Worker creation
with each supplied Cloudflare token also returned HTTP 403:
`No access to the specified resource.` No OS Workers were created.

Save a Cloudflare **Edit Cloudflare Workers** token for the configured account as
the private GitHub repository secret `CLOUDFLARE_API_TOKEN`. The workflow accepts
that replacement independently of the existing `CFOS_DEPLOY_CREDENTIALS` secret.
Provider credentials remain in the original secret; no keys are committed.

Deploy by pushing the completed source to `codex/recovery-20261004`. The Router
deploys last, followed by live Worker binding and OAuth endpoint checks.
Snowflake and Hugging Face user consent takes place in the browser after deployment.
