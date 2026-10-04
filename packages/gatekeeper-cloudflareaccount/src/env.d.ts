interface Env {
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "CloudflareAccountConnection" | "CloudflareAccountGatekeeper";
  }
}
declare module "*.txt" { const value: string; export default value; }
