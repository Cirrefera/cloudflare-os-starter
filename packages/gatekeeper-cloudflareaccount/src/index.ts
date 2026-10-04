export * from "./cloudflareaccount.js";
export default {
  async fetch(): Promise<Response> {
    return new Response("Cloudflare Account Gatekeeper worker is running.");
  },
};
