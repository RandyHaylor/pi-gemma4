/**
 * Pi extension: control model reasoning/thinking on the outgoing provider call,
 * and log all provider traffic for debugging.
 *
 * WHY: some local models (e.g. gemma4 on ollama's OpenAI /v1) only disable their
 * thinking phase when the request body carries an explicit `reasoning_enabled:
 * false`. Pi's built-in thinking controls emit other shapes (reasoning_effort,
 * enable_thinking, reasoning:{enabled}, chat_template_kwargs) but NOT a top-level
 * `reasoning_enabled`, and pi's JSON config has no arbitrary-body-field option.
 * The `before_provider_request` hook lets us inject the exact concrete field.
 *
 * CONCRETE, not generic: the field injected is the literal one this deployment's
 * model needs. It is applied only when the launcher opts in via environment, so a
 * model that must keep thinking is untouched.
 *
 * Environment configuration (set by the launcher / harness adapter per model):
 *   PI_REQUEST_PAYLOAD_INJECTION_JSON -> a JSON object literally merged into every
 *       outgoing provider payload. This is the CONCRETE, per-model spec (the exact
 *       fields THIS model needs), e.g. for gemma4 on ollama:
 *         {"reasoning_enabled": false, "reasoning_effort": "none"}
 *       Unset / empty -> inject nothing; payload passes through untouched.
 *   PI_PROVIDER_TRAFFIC_LOG_PATH      -> file to append request payloads (before AND
 *       after injection) + response status/headers to (unset -> no logging)
 *   PI_PER_TURN_MAX_COMPLETION_TOKENS -> a positive integer merged as `max_completion_tokens`
 *       into every outgoing provider payload (OVERRIDING any value pi set), so THIS pi
 *       launch's turn is hard-capped at that many output tokens. In json mode pi runs one
 *       process PER TURN, so setting this env per launch gives a PER-TURN output cap
 *       (llama.cpp enforces max_completion_tokens; it ignores the older max_tokens). Unset /
 *       non-positive -> no per-turn cap. This is how Unharness's per_turn_output_limit
 *       (the form-driven conveyor's per-step bound) is enforced for the pi/gemma harness.
 */

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function readConcretePayloadInjection(): Record<string, unknown> | undefined {
	const raw = process.env.PI_REQUEST_PAYLOAD_INJECTION_JSON;
	if (raw === undefined || raw.trim() === "") return undefined;
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// malformed injection config: inject nothing rather than break the run
	}
	return undefined;
}

function readPerTurnMaxCompletionTokens(): number | undefined {
	const raw = process.env.PI_PER_TURN_MAX_COMPLETION_TOKENS;
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number.parseInt(raw.trim(), 10);
	if (Number.isFinite(parsed) && parsed > 0) return parsed;
	return undefined;  // non-positive / malformed -> no per-turn cap
}

function appendProviderTrafficLogLine(text: string): void {
	const logPath = process.env.PI_PROVIDER_TRAFFIC_LOG_PATH;
	if (!logPath) return;
	try {
		appendFileSync(logPath, text, "utf8");
	} catch {
		// logging must never break a run
	}
}

export default function reasoningControlAndProviderTrafficLogExtension(pi: ExtensionAPI) {
	const concretePayloadInjection = readConcretePayloadInjection();
	const perTurnMaxCompletionTokens = readPerTurnMaxCompletionTokens();

	pi.on("before_provider_request", (event) => {
		appendProviderTrafficLogLine(
			"\n########## PROVIDER REQUEST injection=" +
				JSON.stringify(concretePayloadInjection || null) +
				" perTurnMaxCompletionTokens=" +
				JSON.stringify(perTurnMaxCompletionTokens ?? null) +
				" ##########\nBEFORE: " +
				JSON.stringify(event.payload) +
				"\n",
		);
		if (concretePayloadInjection !== undefined || perTurnMaxCompletionTokens !== undefined) {
			const modifiedPayload = { ...event.payload, ...(concretePayloadInjection || {}) };
			if (perTurnMaxCompletionTokens !== undefined) {
				// Per-turn hard cap: llama.cpp enforces max_completion_tokens (ignores the
				// older max_tokens). Overrides whatever pi set for this turn.
				modifiedPayload.max_completion_tokens = perTurnMaxCompletionTokens;
			}
			appendProviderTrafficLogLine("AFTER:  " + JSON.stringify(modifiedPayload) + "\n");
			return modifiedPayload;
		}
		// nothing to inject: leave the payload untouched
		return undefined;
	});

	pi.on("after_provider_response", (event) => {
		appendProviderTrafficLogLine(
			"---------- PROVIDER RESPONSE [" +
				String(event.status) +
				"] " +
				JSON.stringify(event.headers) +
				"\n",
		);
	});
}
