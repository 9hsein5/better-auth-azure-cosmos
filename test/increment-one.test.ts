import { randomUUID } from "node:crypto";

import { CosmosClient } from "@azure/cosmos";
import type { Database } from "@azure/cosmos";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cosmosAdapter, ensureAuthContainers } from "../src/index";

/**
 * `incrementOne` is optional in Better Auth 1.6 and required from 1.7, and the official conformance
 * suites do not exercise it, so its semantics are pinned here.
 */
const EMULATOR_ENDPOINT = "https://localhost:8081";
const EMULATOR_KEY =
	"C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

const endpoint = process.env.COSMOS_ENDPOINT ?? EMULATOR_ENDPOINT;
const key = process.env.COSMOS_KEY ?? EMULATOR_KEY;
const databaseId = `increment-${randomUUID().slice(0, 8)}`;

if (endpoint === EMULATOR_ENDPOINT) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const MODELS = ["user", "session", "account", "verification"];
const layout = { kind: "container-per-model", sessionPartition: "tokenHash" } as const;

const client = new CosmosClient({ endpoint, key });
let database: Database;
let adapter: ReturnType<ReturnType<typeof cosmosAdapter>>;

const seed = async (fields: Record<string, unknown>) => {
	const id = randomUUID();
	await adapter.create({
		model: "user",
		data: { id, email: `${id}@example.test`, ...fields },
		forceAllowId: true,
	});
	return id;
};

const readCount = async (id: string): Promise<unknown> => {
	const { resource } = await client.database(databaseId).container("user").item(id, id).read();
	return resource?.attempts;
};

describe("incrementOne", () => {
	beforeAll(async () => {
		const created = await client.databases.createIfNotExists({ id: databaseId });
		database = created.database;
		await ensureAuthContainers(database, { layout, models: MODELS });
		// `attempts` must exist in the schema for `getFieldName` to resolve it.
		adapter = cosmosAdapter(database, { layout })({
			user: { additionalFields: { attempts: { type: "number", required: false } } },
		} as never);
	}, 120_000);

	afterAll(async () => {
		await client
			.database(databaseId)
			.delete()
			.catch(() => undefined);
	}, 60_000);

	it("increments an existing counter and returns the updated row", async () => {
		const id = await seed({ attempts: 5 });
		const updated = await adapter.incrementOne<{ attempts: number }>({
			model: "user",
			where: [{ field: "id", operator: "eq", value: id, connector: "AND" }],
			increment: { attempts: 3 },
		});
		expect(updated?.attempts).toBe(8);
		expect(await readCount(id)).toBe(8);
	}, 60_000);

	it("seeds a counter that does not exist yet, treating absent as zero", async () => {
		const id = await seed({});
		const updated = await adapter.incrementOne<{ attempts: number }>({
			model: "user",
			where: [{ field: "id", operator: "eq", value: id, connector: "AND" }],
			increment: { attempts: 2 },
		});
		expect(updated?.attempts).toBe(2);
	}, 60_000);

	it("applies `set` alongside the increment", async () => {
		const id = await seed({ attempts: 1 });
		const updated = await adapter.incrementOne<{ attempts: number; name: string }>({
			model: "user",
			where: [{ field: "id", operator: "eq", value: id, connector: "AND" }],
			increment: { attempts: 1 },
			set: { name: "limited" },
		});
		expect(updated?.attempts).toBe(2);
		expect(updated?.name).toBe("limited");
	}, 60_000);

	it("returns null when no row matches", async () => {
		const missing = await adapter.incrementOne({
			model: "user",
			where: [{ field: "id", operator: "eq", value: randomUUID(), connector: "AND" }],
			increment: { attempts: 1 },
		});
		expect(missing).toBeNull();
	}, 60_000);

	it("composes concurrent increments instead of losing all but one", async () => {
		const id = await seed({ attempts: 0 });
		const contenders = 8;

		// The reason this is issued without an ETag: under IfMatch these would collide and only one
		// would land. A counter has to accumulate.
		await Promise.all(
			Array.from({ length: contenders }, async () =>
				adapter.incrementOne({
					model: "user",
					where: [{ field: "id", operator: "eq", value: id, connector: "AND" }],
					increment: { attempts: 1 },
				}),
			),
		);

		expect(await readCount(id)).toBe(contenders);
	}, 120_000);
});
