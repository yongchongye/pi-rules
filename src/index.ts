import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerSlashCommands } from "./commands.js";
import { configFromEnvironment } from "./config.js";
import { appendPiRulesLog } from "./log.js";
import { createEngine } from "./rules/engine.js";
import { findRuleCandidates } from "./rules/finder.js";
import { hashContent } from "./rules/matcher.js";
import { findProjectRoot } from "./rules/project-root.js";
import { extractToolPaths } from "./rules/tool-paths.js";
import type { LoadedRule, PiRulesConfig, RuleDiagnostic } from "./rules/types.js";

type PiRulesMode = PiRulesConfig["mode"];

const MODE_VALUES = new Set<string>(["static", "dynamic", "both", "off"]);

/**
 * Dedup scope for dynamic injections. A rule body is identical no matter which
 * file matched it, so the cache key must not include the target path: scoping
 * per path re-injects the same rule once per distinct file read in a session.
 */
const DYNAMIC_SCOPE = "session";

type LogRuleAction = "inject" | "skip";
type LogRuleScope = "static" | "session";

type LogRule = {
	ruleKey: string;
	path: string;
	contentHash: string;
	source: string;
	scope: LogRuleScope;
	action: LogRuleAction;
	reason: string;
};

function sessionId(ctx: ExtensionContext): string | undefined {
	try {
		const manager = ctx.sessionManager as unknown as { getSessionId?: () => string };
		return manager.getSessionId?.();
	} catch {
		return undefined;
	}
}

function logRule(rule: LoadedRule, cwd: string, scope: LogRuleScope, action: LogRuleAction, reason: string): LogRule {
	return {
		ruleKey: `${rule.realPath}::${rule.contentHash}`,
		path: displayPath(cwd, rule.realPath),
		contentHash: rule.contentHash,
		source: rule.source,
		scope,
		action,
		reason,
	};
}

function logDiagnostics(diagnostics: ReadonlyArray<RuleDiagnostic>): ReadonlyArray<RuleDiagnostic> {
	return diagnostics.map(({ severity, source, message }) => ({ severity, source, message }));
}

function outputSummary(text: string): { bytes: number; chars: number; hash: string } {
	return {
		bytes: Buffer.byteLength(text, "utf8"),
		chars: text.length,
		hash: hashContent(text),
	};
}

function toolSkipReason(disabled: boolean, mode: PiRulesMode, isError: boolean): string {
	if (disabled) return "disabled";
	if (isError) return "tool-error";
	if (mode === "off" || mode === "static") return "mode-disabled";
	return "skipped";
}

async function appendCheckLog(common: Record<string, unknown>, record: Record<string, unknown>): Promise<void> {
	await appendPiRulesLog({ ...common, ...record });
}

export default function piRulesExtension(pi: ExtensionAPI): void {
	pi.registerFlag("pi-rules-disabled", {
		type: "boolean",
		default: false,
		description: "Disable pi-rules hooks.",
	});
	pi.registerFlag("pi-rules-mode", {
		type: "string",
		default: "both",
		description: "Rule injection mode: static, dynamic, both, or off.",
	});
	const config = configFromEnvironment();
	const envDisabled = config.disabled;
	const engine = createEngine(config, {
		findCandidates: findRuleCandidates,
		readFile: (path) => {
			try {
				return readFileSync(path, "utf-8");
			} catch {
				return null;
			}
		},
		findProjectRoot,
		extractToolPaths,
	});
	registerSlashCommands(pi, engine);

	function syncConfigFromFlags(): void {
		const disabled = pi.getFlag("pi-rules-disabled");
		const mode = pi.getFlag("pi-rules-mode");

		if (typeof disabled === "boolean") {
			// Boolean flags are presence-only, so `false` means "flag not passed" and must not
			// clear a disable that came from PI_RULES_DISABLED.
			engine.config.disabled = disabled || envDisabled;
		}
		if (typeof mode === "string" && isPiRulesMode(mode)) {
			engine.config.mode = mode;
		}
	}

	pi.on("session_start", async (event, ctx) => {
		const startedAt = Date.now();
		syncConfigFromFlags();
		engine.resetSession(ctx.cwd);
		await appendPiRulesLog({
			event: "reset",
			hook: "session_start",
			reason: "session-reset",
			sourceReason: event.reason,
			sessionId: sessionId(ctx),
			cwd: ctx.cwd,
			mode: engine.config.mode,
			disabled: engine.config.disabled,
			durationMs: Date.now() - startedAt,
		});
		if (engine.config.disabled) {
			return undefined;
		}

		pi.appendEntry("pi-rules.scan", { cwd: ctx.cwd, reason: event.reason });
		return undefined;
	});

	pi.on("session_compact", async (_event, ctx) => {
		const startedAt = Date.now();
		engine.resetSession(ctx.cwd);
		await appendPiRulesLog({
			event: "reset",
			hook: "session_compact",
			reason: "compact-reset",
			sessionId: sessionId(ctx),
			cwd: ctx.cwd,
			mode: engine.config.mode,
			disabled: engine.config.disabled,
			durationMs: Date.now() - startedAt,
		});
		pi.appendEntry("pi-rules.scan", { cwd: ctx.cwd, reason: "compact" });
		return undefined;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const startedAt = Date.now();
		syncConfigFromFlags();
		const common = {
			event: "check",
			hook: "before_agent_start",
			sessionId: sessionId(ctx),
			cwd: ctx.cwd,
			mode: engine.config.mode,
		};
		if (engine.config.disabled || engine.config.mode === "off" || engine.config.mode === "dynamic") {
			await appendCheckLog(common, {
				action: "skip",
				reason: engine.config.disabled ? "disabled" : "mode-disabled",
				rules: [],
				durationMs: Date.now() - startedAt,
			});
			return undefined;
		}

		const loaded = engine.loadStaticRules(ctx.cwd);
		const nativeContextPaths = new Set(
			event.systemPromptOptions.contextFiles?.flatMap((contextFile) => pathKeys(contextFile.path)) ?? [],
		);
		const decisions: LogRule[] = [];
		const rules: LoadedRule[] = [];
		for (const rule of loaded.rules) {
			if (nativeContextPaths.has(rule.path) || nativeContextPaths.has(rule.realPath)) {
				engine.markStaticInjected(rule);
				decisions.push(logRule(rule, ctx.cwd, "static", "skip", "native-context"));
				continue;
			}
			if (engine.isStaticInjected(rule)) {
				decisions.push(logRule(rule, ctx.cwd, "static", "skip", "already-injected"));
				continue;
			}
			decisions.push(logRule(rule, ctx.cwd, "static", "inject", "new"));
			rules.push(rule);
		}

		if (rules.length === 0) {
			await appendCheckLog(common, {
				action: "skip",
				reason: loaded.rules.length === 0 ? "no-rules" : "deduped",
				rulesFound: loaded.rules.length,
				rulesInjected: 0,
				rulesSkipped: decisions.length,
				rules: decisions,
				diagnostics: logDiagnostics(loaded.diagnostics),
				durationMs: Date.now() - startedAt,
			});
			return undefined;
		}

		const block = engine.formatStatic(rules);
		for (const rule of rules) {
			engine.markStaticInjected(rule);
		}

		await appendCheckLog(common, {
			action: "inject",
			reason: "new",
			rulesFound: loaded.rules.length,
			rulesInjected: rules.length,
			rulesSkipped: decisions.length - rules.length,
			rules: decisions,
			diagnostics: logDiagnostics(loaded.diagnostics),
			output: outputSummary(block),
			durationMs: Date.now() - startedAt,
		});
		return { systemPrompt: event.systemPrompt + block };
	});

	pi.on("tool_result", async (event, ctx) => {
		const startedAt = Date.now();
		syncConfigFromFlags();
		const common = {
			event: "check",
			hook: "tool_result",
			sessionId: sessionId(ctx),
			cwd: ctx.cwd,
			mode: engine.config.mode,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
		};
		if (engine.config.disabled || engine.config.mode === "off" || engine.config.mode === "static" || event.isError) {
			await appendCheckLog(common, {
				action: "skip",
				reason: toolSkipReason(engine.config.disabled, engine.config.mode, event.isError),
				targetPaths: [],
				rules: [],
				durationMs: Date.now() - startedAt,
			});
			return undefined;
		}

		const targetPaths = extractToolPaths(event, ctx.cwd);
		const firstTargetPath = targetPaths[0];
		if (firstTargetPath === undefined) {
			await appendCheckLog(common, {
				action: "skip",
				reason: "no-target",
				targetPaths: [],
				rules: [],
				durationMs: Date.now() - startedAt,
			});
			return undefined;
		}

		const fingerprints = engine.fingerprintDynamicTargets(ctx.cwd, targetPaths);
		const pendingFingerprints = fingerprints.filter((target) => !engine.isDynamicTargetFingerprintCurrent(target));
		if (pendingFingerprints.length === 0) {
			engine.commitDynamicTargetFingerprints(fingerprints);
			await appendCheckLog(common, {
				action: "skip",
				reason: "target-unchanged",
				targetPaths,
				fingerprints,
				rules: [],
				durationMs: Date.now() - startedAt,
			});
			return undefined;
		}

		const loaded = engine.loadDynamicRules(
			ctx.cwd,
			pendingFingerprints.map((target) => target.targetPath),
		);
		engine.commitDynamicTargetFingerprints(fingerprints);
		const decisions = loaded.rules.map((rule) => {
			if (engine.isStaticInjected(rule)) {
				return logRule(rule, ctx.cwd, "static", "skip", "already-static-injected");
			}
			if (engine.isDynamicInjected(DYNAMIC_SCOPE, rule)) {
				return logRule(rule, ctx.cwd, "session", "skip", "already-injected");
			}
			return logRule(rule, ctx.cwd, "session", "inject", "new");
		});
		const rules = loaded.rules.filter(
			(rule) => !engine.isStaticInjected(rule) && !engine.isDynamicInjected(DYNAMIC_SCOPE, rule),
		);
		if (rules.length === 0) {
			await appendCheckLog(common, {
				action: "skip",
				reason: loaded.rules.length === 0 ? "no-rules" : "deduped",
				targetPaths,
				pendingTargets: pendingFingerprints.length,
				rulesFound: loaded.rules.length,
				rulesInjected: 0,
				rulesSkipped: decisions.length,
				rules: decisions,
				diagnostics: logDiagnostics(loaded.diagnostics),
				durationMs: Date.now() - startedAt,
			});
			return undefined;
		}

		const firstPendingTarget = pendingFingerprints[0]?.targetPath ?? firstTargetPath;
		const block = engine.formatDynamic(rules, displayPath(ctx.cwd, firstPendingTarget));
		for (const rule of rules) {
			engine.markDynamicInjected(DYNAMIC_SCOPE, rule);
		}

		await appendCheckLog(common, {
			action: "inject",
			reason: "new",
			targetPaths,
			pendingTargets: pendingFingerprints.length,
			rulesFound: loaded.rules.length,
			rulesInjected: rules.length,
			rulesSkipped: decisions.length - rules.length,
			rules: decisions,
			diagnostics: logDiagnostics(loaded.diagnostics),
			output: outputSummary(block),
			durationMs: Date.now() - startedAt,
		});
		return { content: [...event.content, { type: "text", text: block }] };
	});
}

function isPiRulesMode(value: string): value is PiRulesMode {
	return MODE_VALUES.has(value);
}

function pathKeys(filePath: string): string[] {
	try {
		return [filePath, realpathSync.native(filePath)];
	} catch {
		return [filePath];
	}
}

function displayPath(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
}
