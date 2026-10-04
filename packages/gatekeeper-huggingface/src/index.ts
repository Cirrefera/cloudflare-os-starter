export * from "./huggingface.js";
export { HuggingFaceConnection } from "./oauth.js";
import { fetchConnection } from "./oauth.js";
export default { fetch: fetchConnection };
