import type { Database } from "@azure/cosmos";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cosmosAdapter } from "../src/index";

/**
 * The warning exists because silence reads as protection: Better Auth declares unique constraints
 * that a partition-scoped Cosmos unique key cannot enforce, and nothing else surfaces that.
 */
const layout = { kind: "container-per-model", sessionPartition: "tokenHash" } as const;

// Containers are resolved lazily, so constructing the adapter needs no live connection.
const database = {} as Database;

const construct = (): string[] => {
	const warnings: string[] = [];
	const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
	try {
		cosmosAdapter(database, { layout })({} as never);
	} finally {
		spy.mockRestore();
	}
	return warnings;
};

describe("declared uniqueness that Cosmos cannot enforce", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("warns once, naming every unenforceable constraint", () => {
		const warnings = construct();

		expect(warnings).toHaveLength(1);
		const message = warnings[0] ?? "";
		expect(message).toContain("better-auth-azure-cosmos");
		expect(message).toContain("NOT enforced by the database");

		// Declared unique on every supported version.
		expect(message).toContain("user.email");
	});

	it("names only models and fields, never stored values", () => {
		const message = construct()[0] ?? "";

		// `session.token` and `user.email` are field *names* and must appear. What must never appear
		// is data: an address, or a token/hash-shaped run of characters.
		expect(message).toContain("session.token");
		expect(message).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/iu);
		expect(message).not.toMatch(/[A-Za-z0-9]{32,}/u);
		expect(message).toMatch(/uniqueKeyPolicy/u);
	});
});
