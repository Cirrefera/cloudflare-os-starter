// GitHub-hosted deployment using one repository secret, with isolated per-Worker inputs.
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "jsonc-parser";
import { validateConfig } from "./deploy.ts";
import { secretContracts, validateWorkerSource } from "./deployment-secrets.ts";

const root = resolve(import.meta.dirname, "..");
const names = ["CLOUDFLARE_API_TOKEN", "SNOWFLAKE_ACCOUNT", "SNOWFLAKE_ROLE",
  "SNOWFLAKE_CLIENT_ID", "SNOWFLAKE_CLIENT_SECRET", "CLOUDFLARE_ACCOUNT_GATEKEEPER_TOKEN"] as const;
const validateOnly = process.argv[2] === "--validate-only";
if (validateOnly ? process.argv.length !== 4 : process.argv.length !== 2) {
  throw new Error("Usage: node scripts/github-deploy.ts [--validate-only <credential-json-path>]");
}
let values: Record<string, string>;
try {
  const input: unknown = JSON.parse(validateOnly
    ? readFileSync(process.argv[3]!, "utf8") : process.env.CFOS_DEPLOY_CREDENTIALS ?? "");
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error();
  values = input as Record<string, string>;
  for (const name of names) {
    if (typeof values[name] !== "string" || !values[name].trim()) throw new Error();
  }
  if (Object.keys(values).some(name => !names.includes(name as typeof names[number]))) throw new Error();
} catch {
  throw new Error("CFOS_DEPLOY_CREDENTIALS must contain all six named deployment fields as nonempty strings. Values were not printed.");
}
const config = validateConfig(parse(readFileSync(join(root, "deployment.jsonc"), "utf8")));
const sources = secretContracts(config).map(contract => {
  let source: Record<string, string> = {};
  if (contract.workerName === config.gatekeepers.snowflake?.workerName) {
    source = { SNOWFLAKE_ACCOUNT: values.SNOWFLAKE_ACCOUNT!, SNOWFLAKE_ROLE: values.SNOWFLAKE_ROLE!,
      CLIENT_ID: values.SNOWFLAKE_CLIENT_ID!, CLIENT_SECRET: values.SNOWFLAKE_CLIENT_SECRET! };
  } else if (contract.workerName === config.gatekeepers.cloudflareaccount?.workerName) {
    source = { CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_ACCOUNT_GATEKEEPER_TOKEN! };
  }
  const errors = validateWorkerSource(contract, source);
  if (errors.length) throw new Error(errors.join("\n"));
  return { contract, source };
});
if (validateOnly) {
  console.log(`Credential input validates for ${sources.length} configured Gatekeeper Workers; nothing was deployed.`);
} else {
  if (process.env.GITHUB_ACTIONS !== "true") throw new Error("Run deployment through the GitHub Actions workflow.");
  for (const value of Object.values(values)) {
    console.log(`::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
  }
  await mkdir(join(root, ".secrets"), { recursive: true, mode: 0o700 });
  for (const { contract, source } of sources) {
    await writeFile(join(root, ".secrets", `${contract.workerName}.json`), JSON.stringify(source), { mode: 0o600, flag: "wx" });
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: config.accountId,
    WRANGLER_SEND_METRICS: "false", VP_RUN_CONCURRENCY_LIMIT: "2" };
  delete env.CFOS_DEPLOY_CREDENTIALS;
  const auth = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/scripts`, {
    headers: { Authorization: `Bearer ${values.CLOUDFLARE_API_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!auth.ok) throw new Error(`Cloudflare account verification failed (HTTP ${auth.status}); nothing was deployed.`);
  const account = await auth.json() as { success?: boolean };
  if (!account.success) throw new Error("Cloudflare account verification failed; nothing was deployed.");
  const deploy = spawnSync(process.execPath, [join(root, "scripts/deploy.ts"), "--with-secrets"], { cwd: root, env, stdio: "inherit" });
  if (deploy.error || deploy.status !== 0) throw new Error("Cloudflare deployment did not finish; inspect the Worker deployment log.");
}
