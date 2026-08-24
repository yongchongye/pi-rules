import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_LOG_RECORD_BYTES = 32 * 1024;
const MAX_LOG_FILE_BYTES = 256 * 1024;

export type PiRulesLogRecord = Record<string, unknown>;

function logPath(): string {
	const agentDirectory = process.env["PI_CODING_AGENT_DIR"]?.trim() || join(homedir(), ".pi", "agent");
	return join(agentDirectory, "logs", "pi-rules.jsonl");
}

async function resetWhenFull(path: string, lineBytes: number): Promise<void> {
	try {
		const { size: currentSize } = await stat(path);
		if (currentSize + lineBytes > MAX_LOG_FILE_BYTES) {
			await truncate(path, 0);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export async function appendPiRulesLog(record: PiRulesLogRecord): Promise<void> {
	try {
		const serialized = JSON.stringify({
			ts: new Date().toISOString(),
			extension: "pi-rules",
			...record,
		});
		if (serialized === undefined) return;
		const line = `${serialized}\n`;
		if (Buffer.byteLength(line, "utf8") > MAX_LOG_RECORD_BYTES) return;

		const path = logPath();
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		await resetWhenFull(path, Buffer.byteLength(line, "utf8"));
		await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
	} catch {
		// Logging must never change rule injection behavior.
	}
}
