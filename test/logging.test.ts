import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionContext,
	SessionStartEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import piRulesExtension from "../src/index.js";
import { appendPiRulesLog } from "../src/log.js";
import { createFakePi } from "./helpers/fake-pi.js";

const SAMPLE_PROJECT = path.resolve("test/fixtures/sample-project");

type LogRecord = Record<string, unknown>;

type LogRule = {
	action: string;
	reason: string;
	ruleKey: string;
};

function readLog(sessionId: string): LogRecord[] {
	const logPath = path.join(process.env["PI_CODING_AGENT_DIR"] ?? "", "logs", "pi-rules.jsonl");
	try {
		return readFileSync(logPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as LogRecord)
			.filter((record) => record["sessionId"] === sessionId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function sessionStartEvent(): SessionStartEvent {
	return { type: "session_start", reason: "startup" };
}

function beforeAgentStartEvent(): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "Inspect the project.",
		systemPrompt: "Base prompt.",
		systemPromptOptions: { cwd: SAMPLE_PROJECT, contextFiles: [] },
	};
}

function readToolResult(filePath: string, toolCallId: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "read",
		toolCallId,
		input: { path: filePath },
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		details: undefined,
	};
}

function rules(record: LogRecord): LogRule[] {
	return (record["rules"] as LogRule[] | undefined) ?? [];
}

describe("pi-rules logging", () => {
	it("#given a fresh session #when static rules are checked twice #then the second check logs deduplication", async () => {
		// given
		const sessionId = `static-${Date.now()}`;
		const harness = createFakePi();
		piRulesExtension(harness.pi);
		const ctx = harness.makeCtx({
			cwd: SAMPLE_PROJECT,
			sessionManager: { getSessionId: () => sessionId } as unknown as ExtensionContext["sessionManager"],
		});

		// when
		await harness.emit("session_start", sessionStartEvent(), ctx);
		await harness.emit("before_agent_start", beforeAgentStartEvent(), ctx);
		await harness.emit("before_agent_start", beforeAgentStartEvent(), ctx);

		// then
		const records = readLog(sessionId);
		const checks = records.filter((record) => record["hook"] === "before_agent_start");
		expect(checks).toHaveLength(2);
		expect(checks[0]?.["action"]).toBe("inject");
		expect(rules(checks[0] ?? {}).some((rule) => rule.action === "inject")).toBe(true);
		const agentsRule = rules(checks[0] ?? {}).find((rule) => rule.ruleKey.includes("AGENTS.md"));
		const agentsPath = path.join(SAMPLE_PROJECT, "AGENTS.md");
		const agentsHash = createHash("sha256").update(readFileSync(agentsPath)).digest("hex");
		expect(agentsRule?.ruleKey).toBe(`${realpathSync.native(agentsPath)}::${agentsHash}`);
		expect(checks[1]?.["action"]).toBe("skip");
		expect(rules(checks[1] ?? {}).some((rule) => rule.reason === "already-injected")).toBe(true);
		expect(records.find((record) => record["event"] === "reset")?.["reason"]).toBe("session-reset");
	});

	it("#given a dynamic rule was injected #when the same target is read twice #then the second check logs unchanged", async () => {
		// given
		const sessionId = `dynamic-${Date.now()}`;
		const harness = createFakePi();
		piRulesExtension(harness.pi);
		const ctx = harness.makeCtx({
			cwd: SAMPLE_PROJECT,
			sessionManager: { getSessionId: () => sessionId } as unknown as ExtensionContext["sessionManager"],
		});
		const targetPath = path.join(SAMPLE_PROJECT, "apps/web/src/App.tsx");

		// when
		await harness.emit("session_start", sessionStartEvent(), ctx);
		await harness.emit("tool_result", readToolResult(targetPath, "first"), ctx);
		await harness.emit("tool_result", readToolResult(targetPath, "second"), ctx);

		// then
		const checks = readLog(sessionId).filter((record) => record["hook"] === "tool_result");
		expect(checks).toHaveLength(2);
		expect(checks[0]?.["action"]).toBe("inject");
		expect(checks[1]?.["action"]).toBe("skip");
		expect(checks[1]?.["reason"]).toBe("target-unchanged");
	});

	it("#given an oversized record #when pi-rules logs it #then the record is dropped", async () => {
		// given
		const sessionId = `oversized-${Date.now()}`;

		// when
		await appendPiRulesLog({ event: "check", sessionId, payload: "x".repeat(40_000) });

		// then
		expect(readLog(sessionId)).toHaveLength(0);
	});

	it("#given static rules were injected #when the session compacts #then reset and reinjection are logged", async () => {
		// given
		const sessionId = `compact-${Date.now()}`;
		const harness = createFakePi();
		piRulesExtension(harness.pi);
		const ctx = harness.makeCtx({
			cwd: SAMPLE_PROJECT,
			sessionManager: { getSessionId: () => sessionId } as unknown as ExtensionContext["sessionManager"],
		});
		await harness.emit("session_start", sessionStartEvent(), ctx);
		await harness.emit("before_agent_start", beforeAgentStartEvent(), ctx);

		// when
		await harness.emit("session_compact", { type: "session_compact" }, ctx);
		await harness.emit("before_agent_start", beforeAgentStartEvent(), ctx);

		// then
		const records = readLog(sessionId);
		const checks = records.filter((record) => record["hook"] === "before_agent_start");
		expect(checks).toHaveLength(2);
		expect(checks.every((record) => record["action"] === "inject")).toBe(true);
		expect(records.find((record) => record["hook"] === "session_compact")?.["reason"]).toBe("compact-reset");
	});
});
