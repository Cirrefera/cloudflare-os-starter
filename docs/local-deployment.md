# Deploy from Windows

This package contains the complete pinned upstream source and the four custom gatekeepers,
including Snowflake and Hugging Face browser OAuth. No account credentials are included.
Node.js 24.19 or newer and Git for Windows must be installed. Upstream ships symbolic links;
enable Windows Developer Mode or run the launcher in an Administrator PowerShell.

The portable ZIP contains `start-local.ps1` and `cloudflare-os.bundle`. Extract both, then run
`start-local.ps1`. Git checks out the exact packaged working tree, preserving upstream link
metadata and the pinned commit used for verification. The checkout is a new snapshot; the
original cloud checkout and its uncommitted changes were not committed or pushed.

If you already have this source checkout locally, run from its directory:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\deploy-local.ps1
```

The script securely prompts for the Snowflake application client ID/secret already returned by
your Snowflake setup, and the API token used by the supplied Cloudflare Account integration.
Existing `.secrets` JSON files are reused. To import those files from another local folder, pass
`-SecretsDirectory 'C:\path\to\secrets'`. Hugging Face and AlphaXiv need no secret file contents.

Cloudflare deployment uses `wrangler login`, which opens your browser. Select the Cloudflare
account owning the configured account ID. The script installs pinned dependencies, verifies
upstream source provenance, runs only existing upstream tests, builds every module, validates
Worker bundles and isolated secrets, then deploys the configured service graph. It stops on
any error. `-CheckOnly` validates without login or deployment.

After deployment it checks the public Hugging Face metadata and opens
https://hellgate-os-router.mchayes89.workers.dev. Connect Snowflake and Hugging Face in the OS;
Snowflake redirects back to `/gatekeeper/snowflake/oauth`, matching the application setup.

Your existing Cloudflare Access configuration must allow your OS session and leave Hugging
Face's metadata path public for provider registration. Browser consent remains a user action;
a successful build does not establish that private-provider access has been exercised.
