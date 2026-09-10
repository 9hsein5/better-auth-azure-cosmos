import type { Database } from "@azure/cosmos";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cosmosAdapter } from "../src/index";
import type { CosmosLayoutOptions } from "../src/layout";

/**
 * The warning exists because silence reads as protection: Better Auth declares unique constraints
 * that a partition-scoped Cosmos unique key cannot enforce, and nothing else surfaces that.
 */
const layout = { kind: "container-per-model", sessionPartition: "tokenHash" } as const;

/** The only layout under which Cosmos can enforce `(providerId, accountId)`. */
const enforcingLayout = { ...layout, accountPartition: "accountKey" as const };

/**
 * Better Auth 1.7.3+ no longer declares the account identity pair unique in its core schema (1.7.0
 * through 1.7.2 did, on the since-removed `issuer` field), so an application that wants the
 * database to hold that line declares the compound index itself. A plugin schema is the supported
 * way to add a table-level index, and it is exactly what the warning must classify correctly.
 */
const accountIdentityIndex: BetterAuthPlugin = {
	id: "account-identity-index",
	schema: {
		account: {
			fields: {},
			indexes: [{ fields: ["providerId", "accountId"], unique: true }],
		},
	},
};

const withAccountIndex: BetterAuthOptions = { plugins: [accountIdentityIndex] };

// Containers are resolved lazily, so constructing the adapter needs no live connection.
const database = {} as Database;

const construct = (
	options: CosmosLayoutOptions = layout,
	authOptions: BetterAuthOptions = {},
): string[] => {
	const warnings: string[] = [];
	const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "));
	});
	try {
		cosmosAdapter(database, { layout: options })(authOptions);
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

	it("does not invent an account identity constraint the schema never declared", () => {
		const message = construct()[0] ?? "";

		// Nothing to enforce means nothing to warn about; a phantom entry would teach operators
		// to ignore the list.
		expect(message).not.toMatch(/account\(/u);
	});

	it("reports a declared account identity key as unenforceable under the default layout", () => {
		const message = construct(layout, withAccountIndex)[0] ?? "";

		// Partitioned by /id, so two rows sharing (providerId, accountId) sit in different
		// partitions and no partition-scoped unique key can see the collision.
		expect(message).toMatch(/account\(providerId, ?accountId\)/u);
	});

	it("stays silent about the account identity key once the layout enforces it", () => {
		const message = construct(enforcingLayout, withAccountIndex)[0] ?? "";

		// A false alarm is worse than silence: it teaches operators to ignore the warning
		// and to add redundant application-level enforcement the database already provides.
		expect(message).not.toMatch(/account\(/u);
		expect(message).toContain("user.email");
	});

	it("constructs the enforcing layout without a live connection", () => {
		// `accountKey` hashes core account fields, so construction must not refuse on any
		// supported Better Auth version.
		expect(() => construct(enforcingLayout)).not.toThrow();
	});

	it("refuses the enforcing layout when a hashed account field is mapped to another name", () => {
		// The hash and the unique key policy both read the stored `providerId`/`accountId` paths, so a
		// renamed field would leave every account write without a partition key. Better to fail here.
		expect(() =>
			construct(enforcingLayout, { account: { fields: { providerId: "provider" } } }),
		).toThrow(/providerId/u);
		expect(() =>
			construct(enforcingLayout, { account: { fields: { accountId: "externalId" } } }),
		).toThrow(/accountId/u);
		// The default layout does not hash those fields, so the same mapping is fine there.
		expect(() => construct(layout, { account: { fields: { providerId: "provider" } } })).not.toThrow();
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
