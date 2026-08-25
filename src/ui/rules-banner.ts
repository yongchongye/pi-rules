import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import type { LoadedRule, RuleDiagnostic } from "../rules/types.js";
import { DynamicBorder } from "./dynamic-border.js";

export interface RulesBannerProps {
	ruleCount: number;
	diagnostics: ReadonlyArray<RuleDiagnostic>;
	topRules?: ReadonlyArray<Pick<LoadedRule, "relativePath" | "matchReason"> & { path?: string }>;
}

export class RulesBanner extends Container {
	constructor(
		private readonly props: RulesBannerProps,
		private readonly theme: Theme,
	) {
		super();
	}

	override render(width: number): string[] {
		return renderBannerLines(this.props, this.theme, width);
	}

	override invalidate(): void {}
}

export function renderBannerLines(props: RulesBannerProps, theme: Theme, width: number): string[] {
	const lines: string[] = [];
	const border = new DynamicBorder((str) => theme.fg("border", str));

	if (props.ruleCount === 0) {
		lines.push(...border.render(width));
		lines.push(`${theme.bold(theme.fg("accent", "[pi-rules]"))} No rules discovered`);
		lines.push(...border.render(width));
		return lines;
	}

	lines.push(...border.render(width));
	lines.push(
		`${theme.bold(theme.fg("accent", "[pi-rules]"))} ${theme.fg("muted", `${props.ruleCount} active rules`)}`,
	);
	lines.push("");

	if (props.topRules) {
		for (const rule of props.topRules) {
			const hasDiagnostic = props.diagnostics.some(
				(diagnostic) => diagnostic.source === rule.path || diagnostic.source === rule.relativePath,
			);
			const indicator = hasDiagnostic ? theme.fg("error", "⚠") : theme.fg("success", "●");

			let annotation = "";
			if (typeof rule.matchReason === "object" && rule.matchReason.kind === "glob") {
				annotation = ` ${theme.fg("muted", rule.matchReason.pattern)}`;
			}

			lines.push(`  ${indicator} ${rule.relativePath}${annotation}`);
		}
	}

	if (props.diagnostics.length > 0) {
		lines.push(`  ${theme.fg("warning", `⚠ ${props.diagnostics.length} warning(s)`)}`);
	}

	lines.push("");
	lines.push(...border.render(width));

	return lines;
}

export const RULES_STATUS_KEY = "pi-rules";

type RulePath = Pick<LoadedRule, "path" | "relativePath">;

export interface StatusLineInput {
	ruleCount: number;
	hasErrors: boolean;
	rulePaths?: ReadonlyArray<string>;
}

export interface RulesStatusUI {
	readonly theme?: Theme;
	setStatus(key: string, text: string | undefined): void;
}

/**
 * Keep familiar project-relative labels until names collide. Colliding paths
 * gain the shortest distinct absolute-path suffix, prefixed with an ellipsis.
 */
export function shortenDistinctRulePaths(rules: ReadonlyArray<RulePath>): string[] {
	const labels = rules.map((rule) => rule.relativePath || rule.path);
	const suffixLengths = labels.map(pathSegmentCount);

	while (true) {
		const duplicateGroups = duplicateIndexGroups(labels);
		if (duplicateGroups.length === 0) return labels;

		let changed = false;
		for (const indexes of duplicateGroups) {
			for (const index of indexes) {
				const rule = rules[index];
				if (rule === undefined) continue;

				const nextLength = (suffixLengths[index] ?? 1) + 1;
				const nextLabel = pathSuffix(rule.path, nextLength);
				if (nextLabel === labels[index]) continue;

				labels[index] = nextLabel;
				suffixLengths[index] = nextLength;
				changed = true;
			}
		}

		if (!changed) {
			return labels.map((label, index) => `${label} (${index + 1})`);
		}
	}
}

/**
 * Create the complete active-rule list that is appended to injected tool output.
 */
export function activeRuleListText(rules: ReadonlyArray<RulePath>, maxChars = Number.POSITIVE_INFINITY): string {
	const header = `[pi-rules] ${rules.length} active`;
	if (maxChars < header.length) return "";

	let text = header;
	for (const [index, path] of sortRulePaths(shortenDistinctRulePaths(rules)).entries()) {
		const line = `\n- ${path}`;
		if (text.length + line.length <= maxChars) {
			text += line;
			continue;
		}

		const omission = `\n- … ${rules.length - index} more`;
		return text.length + omission.length <= maxChars ? `${text}${omission}` : text;
	}
	return text;
}

export function statusLineText(input: StatusLineInput, theme?: Theme): string {
	const paths = sortRulePaths(input.rulePaths ?? []);
	const ruleList = paths.length > 0 ? ` · ${paths.join(", ")}` : "";
	const base = `[pi-rules] ${input.ruleCount} active${ruleList}`;
	if (input.hasErrors) {
		if (theme === undefined) return `${base} · ⚠ errors`;
		return theme.fg("muted", `${base} · `) + theme.fg("error", "⚠ errors");
	}
	return theme === undefined ? base : theme.fg("muted", base);
}

export function setRulesStatus(
	ui: RulesStatusUI,
	rules: ReadonlyArray<RulePath>,
	diagnostics: ReadonlyArray<RuleDiagnostic>,
): void {
	const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
	ui.setStatus(
		RULES_STATUS_KEY,
		statusLineText(
			{
				ruleCount: rules.length,
				hasErrors,
				rulePaths: shortenDistinctRulePaths(rules),
			},
			ui.theme,
		),
	);
}

function duplicateIndexGroups(values: ReadonlyArray<string>): number[][] {
	const indexesByValue = new Map<string, number[]>();
	for (const [index, value] of values.entries()) {
		const indexes = indexesByValue.get(value) ?? [];
		indexes.push(index);
		indexesByValue.set(value, indexes);
	}
	return [...indexesByValue.values()].filter((indexes) => indexes.length > 1);
}

function pathSegmentCount(filePath: string): number {
	return Math.max(1, pathSegments(filePath).length);
}

function pathSuffix(filePath: string, length: number): string {
	const segments = pathSegments(filePath);
	if (segments.length === 0 || length >= segments.length) return filePath;
	return `…/${segments.slice(-length).join("/")}`;
}

function pathSegments(filePath: string): string[] {
	return filePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function sortRulePaths(paths: ReadonlyArray<string>): string[] {
	return paths.filter((path) => path.length > 0).sort((a, b) => a.localeCompare(b));
}
