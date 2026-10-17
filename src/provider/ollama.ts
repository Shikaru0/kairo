import { openaiCompatible } from "./openai.ts";
import type { Provider } from "./provider.ts";

/**
 * Ollama serves the OpenAI protocol on `/v1`.
 * See https://docs.ollama.com/api/openai-compatibility
 */
export function ollama(host = "http://127.0.0.1:11434"): Provider {
  return openaiCompatible({ id: "ollama", baseURL: new URL("/v1", host).href, apiKey: "ollama" });
}
