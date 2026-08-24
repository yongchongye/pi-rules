import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const ORIGINAL_AGENT_DIRECTORY = process.env["PI_CODING_AGENT_DIR"];
const TEST_AGENT_DIRECTORY = mkdtempSync(join(tmpdir(), "pi-rules-agent-"));

process.env["PI_CODING_AGENT_DIR"] = TEST_AGENT_DIRECTORY;

for (const key of ["PI_RULES_DISABLED", "PI_RULES_MAX_RULE_CHARS", "PI_RULES_MAX_RESULT_CHARS"]) {
	delete process.env[key];
}

afterAll(() => {
	rmSync(TEST_AGENT_DIRECTORY, { recursive: true, force: true });
	if (ORIGINAL_AGENT_DIRECTORY === undefined) {
		delete process.env["PI_CODING_AGENT_DIR"];
	} else {
		process.env["PI_CODING_AGENT_DIR"] = ORIGINAL_AGENT_DIRECTORY;
	}
});
