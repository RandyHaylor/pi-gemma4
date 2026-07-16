# pi-gemma4 — a lightweight local-LLM coding-agent setup (Pi + gemma4 + web_search)

A self-contained, portable configuration for running the
[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
against a **local gemma4 model**, with:

> **Serving backend (IMPORTANT):** use **llama.cpp** (`llama-server`), NOT ollama,
> when the agent uses **tools**. ollama's built-in gemma4 parser leaks the model's
> `<|tool_call|>` / `<|channel|>` / `<|tool_response|>` control tokens into the
> OpenAI-compat (`/v1`) response instead of stripping them — a known, WON'T-FIX
> ollama issue ([ollama/ollama#15798](https://github.com/ollama/ollama/issues/15798))
> that, under streaming + multi-tool turns, degenerates into hundreds of repeated
> `<|tool_response>` tokens and kills the run. Serving the **same GGUF** via
> llama.cpp with a corrected jinja chat template returns **clean structured
> `tool_calls` with zero leakage** (verified). See "Serving backend" below.

1. **Thinking/reasoning turned OFF** for gemma4 — done *natively inside Pi* via a
   small `before_provider_request` extension that injects concrete request fields.
   **The concrete field is BACKEND-SPECIFIC** (this was verified the hard way):
   - **llama.cpp:** `{"chat_template_kwargs": {"enable_thinking": false}}`  ← current backend
   - **ollama:** `{"reasoning_enabled": false, "reasoning_effort": "none"}`  (ollama-only; llama.cpp ignores it)

   The extension injects whatever `PI_REQUEST_PAYLOAD_INJECTION_JSON` you give it,
   so switching backend = switch that one value. No proxy required.
2. **A `web_search` tool** backed by a private [SearXNG](https://github.com/searxng/searxng)
   JSON API.
3. **Full provider-traffic logging** for debugging (every request payload,
   before and after injection, plus response status/headers).

This is intended as a **lightweight primary local-LLM pathway** for a harness
runner (e.g. `claude-code-cli-runner`) driving Pi as a harness: Pi just makes
OpenAI-style calls to ollama, and this config makes those calls behave.

## Why the extension (and not a proxy or pi config)

Pi's `models.json` cannot inject an arbitrary request-body field, and Pi's
built-in thinking controls emit other shapes (`reasoning_effort`,
`enable_thinking`, `reasoning:{enabled}`, `chat_template_kwargs`) — **not** the
top-level `reasoning_enabled` that gemma4-on-ollama's `/v1` actually honors.
Pi's `before_provider_request` hook *can* rewrite the outgoing payload, so a tiny
extension injects the exact concrete fields. (opencode lacks this per-call
payload hook, which is why opencode needs an external injecting proxy instead.)

**Verified:** with the injection, gemma4 answers directly (e.g. the bat-and-ball
question in ~2–7s with zero thinking blocks) instead of streaming minutes of
reasoning.

## Serving backend: llama.cpp (required for tool-calling)

Serve the gguf with **llama.cpp** (`llama-server`), **not ollama**, whenever the
agent uses tools. Build llama.cpp with CUDA and run:

```bash
llama-server \
  -m <gemma4-31b-jang-q3 gguf> \
  -a 'gemma4-31b-jang-q3:latest' \
  --jinja --chat-template-file chat_templates/gemma4_corrected_chat_template.jinja \
  -ngl 99 -fa on --cache-type-k q8_0 --cache-type-v q8_0 \
  --parallel 1 \
  -c 163840 \
  --host 0.0.0.0 --port 8898
```

- **`--chat-template-file chat_templates/gemma4_corrected_chat_template.jinja`** —
  the model's own gemma4 template with the forced `<|channel>thought…<channel|>`
  block and reasoning-replay removed (this is what stops the token leakage while
  preserving tool-calling). llama.cpp applies it via `--jinja`.
- **`--parallel 1`** — one slot. llama-server defaults to 4 slots, each allocating
  the FULL context, which quadruples KV VRAM. Since the harness runs one task at a
  time, one slot is correct and frees the VRAM for a large context.
- **`-fa on --cache-type-k q8_0 --cache-type-v q8_0`** — flash-attention + q8_0 KV
  quantization, needed to fit a large context.
- **`-c 163840` (160k)** — the empirically verified context edge on a 24 GB
  RTX 3090 Ti: a real ~152k-token session peaks at ~24.0/24.5 GB with no OOM.
  192k OOMs (KV+compute); 256k (model max) OOMs by ~11 GB. gemma4's sliding-window
  attention (5 sliding + 1 full layer, ×10) keeps this affordable; the 10 full-
  attention layers dominate KV at high context.

Point pi's `models.json` `baseUrl` at this server (`http://<host>:8898/v1`).

## Prerequisites

- ollama serving your gemma4 gguf on `:11434` (this setup assumes
  `gemma4-31b-jang-q3:latest`, 96k context). From a libvirt guest, the host is
  reachable at `http://192.168.122.1:11434`.
- A SearXNG instance with the JSON API enabled (see the sibling `SearXNG-Docker`
  repo). Default `web_search` target is `http://localhost:8181`.
- Node.js (Pi is an npm package).

## Install

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
mkdir -p ~/.pi/agent ~/pi_harness_extensions
cp models.example.json ~/.pi/agent/models.json          # edit baseUrl if needed
cp extensions/*.ts ~/pi_harness_extensions/
```

## Configuration (environment)

The extensions are driven entirely by environment variables, so the SAME files
work for any model — you specify the CONCRETE thinking fields for *this* model:

```bash
# Load the extensions (os.pathsep-separated). The runner adapter turns this into -e flags.
export PI_EXTENSION_PATHS="$HOME/pi_harness_extensions/reasoning_control_and_provider_traffic_log.ts:$HOME/pi_harness_extensions/web_search_via_searxng.ts"

# The CONCRETE per-model payload injection (gemma4's thinking-off lever).
# BACKEND-SPECIFIC — for the current llama.cpp backend:
export PI_REQUEST_PAYLOAD_INJECTION_JSON='{"chat_template_kwargs": {"enable_thinking": false}}'
# (For an ollama backend it was instead: {"reasoning_enabled": false, "reasoning_effort": "none"} )
# A model that should keep thinking simply omits this var.

# Debug log of all provider traffic (optional).
export PI_PROVIDER_TRAFFIC_LOG_PATH="$HOME/pi_provider_traffic.log"

# web_search -> SearXNG JSON API.
export SEARXNG_BASE_URL="http://localhost:8181"
```

## Run

```bash
pi --print --mode json \
  --provider ollama --model 'gemma4-31b-jang-q3:latest' \
  --no-context-files --no-skills --no-prompt-templates --no-themes \
  --no-extensions \
  -e "$HOME/pi_harness_extensions/reasoning_control_and_provider_traffic_log.ts" \
  -e "$HOME/pi_harness_extensions/web_search_via_searxng.ts" \
  --tools bash,read,write,edit,grep,find,ls,web_search \
  "your prompt"
```

For an **ingest-style** run with no tools, drop `--tools` (or pass `--tools ""`);
the reasoning-control extension still applies (it registers no tool).

## Files

| Path | Purpose |
|---|---|
| `models.example.json` | Pi custom-provider config → ollama gemma4 (copy to `~/.pi/agent/models.json`). |
| `extensions/reasoning_control_and_provider_traffic_log.ts` | Injects the concrete per-model payload fields (thinking-off) + logs provider traffic. |
| `extensions/web_search_via_searxng.ts` | Registers the `web_search` tool (thin wrapper). |
| `extensions/web_search_via_searxng_core.ts` | Pi-free SearXNG query core (isolation-testable). |

## Notes

- The extension files are also maintained inside the `claude-code-cli-runner`
  repo (`pi_harness_extensions/`), which is what deploys them at runtime; this
  repo is the reference/portable copy of the whole pi+gemma4 pathway.
- **Thinking-off is BACKEND-SPECIFIC** (verified live):
  - **llama.cpp** honors `{"chat_template_kwargs": {"enable_thinking": false}}` and
    **ignores** `reasoning_enabled` — so with llama.cpp set
    `PI_REQUEST_PAYLOAD_INJECTION_JSON='{"chat_template_kwargs": {"enable_thinking": false}}'`.
  - **ollama** honored `{"reasoning_enabled": false, "reasoning_effort": "none"}`
    (both were needed) but ollama is no longer the serving backend for tools.
- Verified end-to-end on the live harness (runner → pi → llama.cpp → gemma4):
  clean structured tool calls, **zero** `<|…|>` leakage, **zero** thinking events,
  task completes `done`.
