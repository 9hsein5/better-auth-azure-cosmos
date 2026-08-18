import type { Database } from "@azure/cosmos";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cosmosAdapter } from "../src/index";
import type { CosmosLayoutOptions } from "../src/layout";

/**
 * The warning exists because silence reads as protection: Better Auth declares unique constraints
 * that a partition-scoped Cosmos unique key cannot enforce, and nothing else surfaces that.
 */
const layout = { kind: "container-per-model", sessionPartition: "tokenHash" } as const;

/**
 * The only layout under which Cosmos can enforce `(issuer, accountId)`. Written on one line and
 * spread from `layout` so the 1.6 compatibility run, which strips standalone `accountPartition`
 * lines from the suite, cannot quietly turn the 1.7 probe below into a false positive.
 */
const enforcingLayout = { ...layout, accountPartition: "accountKey" as const };

// Containers are resolved lazily, so constructing the adapter needs no live connection.
const database = {} as Database;

const construct = (options: CosmosLayoutOptions = layout): string[] => {
	const warnings: string[] = [];
	const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
	try {
		cosmosAdapter(database, { layout: options })({} as never);
	} finally {
		spy.mockRestore();
	}
	return warnings;
};

/** `accountKey` requires better-auth >= 1.7; on 1.6 construction refuses, so the case is moot. */
const supportsAccountKey = ((): boolean => {
	const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	try {
		cosmosAdapter(database, { layout: enforcingLayout })({} as never);
		return true;
	} catch {
		return false;
	} finally {
		spy.mockRestore();
	}
})();

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

	// The constraint itself only exists from better-auth 1.7, which is the same boundary as
	// `accountKey` support, so on 1.6 there is nothing to report either way.
	it.skipIf(!supportsAccountKey)(
		"reports the account identity key as unenforceable under the default layout",
		() => {
			const message = construct()[0] ?? "";

			// Partitioned by /id, so two rows sharing (issuer, accountId) sit in different
			// partitions and no partition-scoped unique key can see the collision.
			expect(message).toMatch(/account\(issuer, ?accountId\)/u);
		},
	);

	it.skipIf(!supportsAccountKey)(
		"stays silent about the account identity key once the layout enforces it",
		() => {
			const message = construct(enforcingLayout)[0] ?? "";

			// A false alarm is worse than silence: it teaches operators to ignore the warning
			// and to add redundant application-level enforcement the database already provides.
			expect(message).not.toMatch(/account\(/u);
			expect(message).toContain("user.email");
		},
	);

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
