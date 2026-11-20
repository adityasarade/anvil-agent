# Free cloud models without local downloads

Anvil can use remotely hosted open-weight models through TrueForge. Model weights stay on the provider’s servers; no Ollama installation or local model download is needed.

## Existing Groq key

`groq/qwen3-8-27b` is registered locally and included in the example provider configuration. Its underlying model is `qwen/qwen3.8-27b`. Groq lists a free tier with limits; see its [current model list](https://console.groq.com/docs/models) and [rate limits](https://console.groq.com/docs/rate-limits). Account-specific availability and remaining quota still apply.

The real inline edit, behavior checks, and undo passed in Antigravity using this model and the selection-only `anvil-inline-direct` agent. Multi-file Task B is a separate validation; do not infer it passed from the inline result.

After reloading the updated VSIX, copy the contents of [free-cloud.settings.json](../../config/free-cloud.settings.json) into **User Settings JSON**, then start a new Anvil chat. This selects Qwen, keeps retrieval at 1,000 estimated tokens, limits the first-turn map, caps output, and asks TrueForge to compact earlier. These settings reduce request size; they do not remove rate limits.

The direct inline agent returns a replacement from the supplied selection without loading editor MCP tools (TrueForge may still expose its built-in tools). Agent mode continues to use MCP discovery, review, and commands through TrueForge. Reasoning is disabled for Qwen using a [documented Groq setting](https://console.groq.com/docs/reasoning).

## Independent free backup

OpenRouter’s [`openrouter/free` router](https://openrouter.ai/docs/guides/routing/routers/free-router) selects an available free model and filters for requested capabilities such as tool calling. It uses a separate account and quota from Gemini/Groq. Model selection can vary between requests; free capacity and request limits apply.

1. Create a key at [OpenRouter](https://openrouter.ai/keys).
2. Put it in `OPENROUTER_API_KEY` in the ignored local `.env`; never paste it into chat or commit it.
3. Run `npm run setup`.
4. Choose `openrouter/free` in **Anvil: Select Model Chain**, then start a new chat.

The prepared configuration points only to the free router. It does not select a paid fallback. Check [OpenRouter’s current free-use limits](https://openrouter.ai/docs/api/reference/limits) before rehearsing; a multi-file tool loop uses multiple requests.

For repeatable coding rehearsals, the provider examples also include Particle-1 and Flint, which OpenRouter currently lists as free coding models. [openrouter-free.settings.json](../../config/openrouter-free.settings.json) selects those two fixed models with a smaller context budget; both underlying model IDs end in `:free`. This avoids random model selection and does not include a paid fallback. A real Particle/Flint rehearsal produced all three required B files; independent acceptance passed 61 CLI tests, help, JSON serialization, masking, and unchanged application configuration. The run was cancelled before its final summary after about 29 minutes, so it is not recorded as a completed agent run. The smaller budget in this profile has not had a full B rehearsal; the observed run used the default context budgets. Free endpoint capacity remains variable.

## Rehearse without spending provider quota

`npm run verify:submission` uses a scripted local test model through real TrueForge and the actual editor smoke test. It downloads no model weights and makes no paid model calls. Use it for mechanical checks; reserve real cloud calls for final A/B/C rehearsals. Scripted tests cannot replace the required real-model demonstration.
