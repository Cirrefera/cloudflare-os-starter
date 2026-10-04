interface Env {
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "AlphaXivConnection" | "AlphaXivGatekeeper";
  }
}
declare module "*.txt" { const value: string; export default value; }
