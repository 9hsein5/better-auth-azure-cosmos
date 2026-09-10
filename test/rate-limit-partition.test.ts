import { randomUUID } from "node:crypto";

import { CosmosClient } from "@azure/cosmos";
import type { Database } from "@azure/cosmos";
import { betterAuth } from "better-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cosmosAdapter, ensureAuthContainers, hashRateLimitKey } from "../src/index";

/**
 * Better Auth declares `rateLimit.key` unique and recovers from a rejected create by re-reading
 * and incrementing the existing row. Under `/id` nothing rejects the duplicate, so a concurrent
 * first burst seeds a row per request and each gets its own budget -- measured as 12 requests
 * producing 12 rows against a limit of 3. Partitioning on `/keyHash` is what makes the constraint
 * enforceable, and therefore what makes that recovery path reachable.
 */
const EMULATOR_ENDPOINT = "https://localhost:8081";
const EMULATOR_KEY =
	"C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

const endpoint = process.env.COSMOS_ENDPOINT ?? EMULATOR_ENDPOINT;
const key = process.env.COSMOS_KEY ?? EMULATOR_KEY;
const databaseId = `ratelimit-${randomUUID().slice(0, 8)}`;

if (endpoint === EMULATOR_ENDPOINT) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const MODELS = ["user", "session", "account", "verification", "rateLimit"];
const layout = {
	kind: "container-per-model",
	sessionPartition: "tokenHash",
	rateLimitPartition: "key",
} as const;

const client = new CosmosClient({ endpoint, key });
let database: Database;

const seedRow = async (limiterKey: string) =>
	database.container("rateLimit").items.create({
		id: randomUUID(),
		key: limiterKey,
		keyHash: hashRateLimitKey(limiterKey),
		count: 1,
		lastRequest: Date.now(),
	});

describe("rateLimit on /keyHash", () => {
	beforeAll(async () => {
		const created = await client.databases.createIfNotExists({ id: databaseId });
		database = created.database;
		await ensureAuthContainers(database, { layout, models: MODELS });
	}, 120_000);

	afterAll(async () => {
		await client
			.database(databaseId)
			.delete()
			.catch(() => undefined);
	}, 60_000);

	it("creates the container with the key as its unique key", async () => {
		const { resource } = await database.container("rateLimit").read();

		expect(resource?.partitionKey?.paths).toStrictEqual(["/keyHash"]);
		expect(resource?.uniqueKeyPolicy?.uniqueKeys).toStrictEqual([{ paths: ["/key"] }]);
	}, 60_000);

	it("rejects a second row for the same limiter key", async () => {
		const limiterKey = `ip-${randomUUID()}:/sign-in`;
		await seedRow(limiterKey);

		await expect(seedRow(limiterKey)).rejects.toThrow(/unique key/iu);
	}, 60_000);

	/** The seeding race the leak came from: only one of a concurrent burst may create the row. */
	it("admits exactly one row from a concurrent first burst", async () => {
		const limiterKey = `ip-${randomUUID()}:/sign-in`;

		const results = await Promise.allSettled(
			Array.from({ length: 12 }, async () => seedRow(limiterKey)),
		);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	}, 120_000);

	it("limits real HTTP bursts and window resets without sharing client budgets", async () => {
		const auth = betterAuth({
			baseURL: "http://localhost:3000",
			secret: "release-validation-only-secret-not-for-production",
			database: cosmosAdapter(database, { layout }),
			rateLimit: { enabled: true, storage: "database", window: 60, max: 3 },
			advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
		});
		const context = await auth.$context;
		const request = (address: string) => auth.handler(new Request(
			"http://localhost:3000/api/auth/get-session",
			{ headers: { "x-forwarded-for": address } },
		));

		for (const round of ["initial", "expired"]) {
			const responses = await Promise.all(Array.from({ length: 12 }, () => request("203.0.113.41")));
			expect(responses.filter((response) => response.status === 200), round).toHaveLength(3);
			expect(responses.filter((response) => response.status === 429), round).toHaveLength(9);
			for (const response of responses.filter((result) => result.status === 429)) {
				expect(Number(response.headers.get("x-retry-after"))).toBeGreaterThan(0);
			}
			const rows = await context.adapter.findMany<{ id: string; count: number }>({
				model: "rateLimit",
				where: [{ field: "count", value: 3 }],
			});
			expect(rows).toHaveLength(1);
			if (round === "initial") {
				await context.adapter.update({
					model: "rateLimit",
					where: [{ field: "id", value: rows[0]!.id }],
					update: { lastRequest: Date.now() - 120_000 },
				});
			}
		}

		expect((await request("203.0.113.42")).status).toBe(200);
		expect((await request("203.0.113.41")).status).toBe(429);
	}, 120_000);
});
