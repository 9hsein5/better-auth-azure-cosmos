import { randomUUID } from "node:crypto";

import { CosmosClient, ErrorResponse } from "@azure/cosmos";
import type { Database } from "@azure/cosmos";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const MODELS = ["user", "session", "account", "verification", "rateLimit"];
const layout = {
	kind: "container-per-model",
	sessionPartition: "tokenHash",
	accountPartition: "accountKey",
	rateLimitPartition: "key",
} as const;

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
			rateLimit: { storage: "database" },
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

	it.each([undefined, null])("matches a null guard against an initial value of %s", async (initial) => {
		const id = await seed({ attempts: initial });
		const updated = await adapter.incrementOne<{ attempts: number }>({
			model: "user",
			where: [
				{ field: "id", value: id },
				{ field: "attempts", value: null },
			],
			increment: { attempts: 2 },
		});

		expect(updated?.attempts).toBe(2);
		expect(await readCount(id)).toBe(2);
	}, 60_000);

	it.each([undefined, null, 0, 5])("keeps null and non-null filters complementary for %s", async (initial) => {
		const id = await seed({ attempts: initial });
		const isNull = initial === undefined || initial === null;
		for (const operator of ["eq", "ne"] as const) {
			const where = [
				{ field: "id", value: id },
				{ field: "attempts", operator, value: null },
			];
			const expected = (operator === "eq" ? isNull : !isNull) ? 1 : 0;
			expect(await adapter.count({ model: "user", where })).toBe(expected);
			expect(await adapter.findMany({ model: "user", where })).toHaveLength(expected);
		}
	}, 60_000);

	it.each([
		{ fieldCount: 10, contenders: 1 },
		{ fieldCount: 11, contenders: 1 },
		{ fieldCount: 10, contenders: 8 },
		{ fieldCount: 11, contenders: 8 },
	])("atomically increments $fieldCount fields with $contenders contenders", async ({ fieldCount, contenders }) => {
		const fields = Array.from({ length: fieldCount }, (_value, index) => `counter${index}`);
		const options = {
			user: {
				additionalFields: Object.fromEntries(
					fields.map((field) => [field, { type: "number" as const, required: false }]),
				),
			},
		};
		const wideAdapter = cosmosAdapter(database, { layout })(options);
		const initial = Object.fromEntries(fields.map((field) => [field, 0]));
		const created = await wideAdapter.create<Record<string, unknown>, { id: string }>({
			model: "user",
			data: { email: `${randomUUID()}@example.test`, ...initial },
		});
		const item = database.container("user").item(created.id, created.id);
		const patch = vi.spyOn(item, "patch");
		const replace = vi.spyOn(item, "replace");
		const boundaryDatabase = { container: () => ({ item: () => item }) } as unknown as Database;
		const mutationAdapter = cosmosAdapter(boundaryDatabase, { layout })(options);
		const increment = Object.fromEntries(fields.map((field) => [field, 1]));
		const updated = await Promise.all(Array.from({ length: contenders }, () =>
			mutationAdapter.incrementOne({
				model: "user",
				where: [{ field: "id", value: created.id }],
				increment,
			}),
		));

		if (fieldCount > 10) {
			expect(patch).not.toHaveBeenCalled();
			expect(replace).toHaveBeenCalledWith(
				expect.objectContaining(increment),
				expect.objectContaining({
					accessCondition: { type: "IfMatch", condition: expect.any(String) },
				}),
			);
		} else {
			expect(patch).toHaveBeenCalledTimes(contenders);
			expect(replace).not.toHaveBeenCalled();
		}
		expect(updated.every((result) => result !== null)).toBe(true);
		const expected = Object.fromEntries(fields.map((field) => [field, contenders]));
		expect(await wideAdapter.findOne({
			model: "user",
			where: [{ field: "id", value: created.id }],
		})).toMatchObject(expected);
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

	it.each([undefined, null])("composes concurrent first increments from %s", async (initial) => {
		const id = await seed({ attempts: initial });
		const contenders = 8;
		const results = await Promise.all(
			Array.from({ length: contenders }, () =>
				adapter.incrementOne({
					model: "user",
					where: [{ field: "id", value: id }],
					increment: { attempts: 1 },
				}),
			),
		);

		expect(results.every((result) => result !== null)).toBe(true);
		expect(await readCount(id)).toBe(contenders);
	}, 120_000);

	it.each([
		{ model: "account", field: "providerId" },
		{ model: "account", field: "accountId" },
		{ model: "session", field: "token" },
		{ model: "rateLimit", field: "key" },
	])("refuses partition-changing writes (model=$model, field=$field)", async ({ model, field }) => {
		const id = randomUUID();
		const value = randomUUID();
		const data = {
			id,
			userId: randomUUID(),
			providerId: value,
			accountId: value,
			token: value,
			key: value,
			count: 0,
			lastRequest: Date.now(),
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await adapter.create({ model, data, forceAllowId: true });
		const where = [{ field: "id", value: id }];

		for (const replacement of [randomUUID(), null]) {
			await expect(
				adapter.incrementOne({ model, where, increment: {}, set: { [field]: replacement } }),
			).rejects.toThrow(/partition/iu);
			await expect(
				adapter.update({ model, where, update: { [field]: replacement } }),
			).rejects.toThrow(/partition/iu);
			await expect(
				adapter.updateMany({ model, where, update: { [field]: replacement } }),
			).rejects.toThrow(/partition/iu);
		}

		await expect(
			adapter.incrementOne({ model, where, increment: { [field]: 1 } }),
		).rejects.toThrow(/partition/iu);
		const unchanged = await adapter.findOne<Record<string, unknown>>({ model, where });
		expect(unchanged?.[field]).toBe(value);
	}, 120_000);

	it.each([404, 412])("handles patch status %s without silently losing increments", async (status) => {
		const error = new ErrorResponse();
		error.code = status;
		const item = {
			read: vi.fn().mockResolvedValue({
				resource: { id: "contended-user", attempts: 0, _etag: "revision-1" },
			}),
			patch: vi.fn().mockRejectedValue(error),
		};
		const mockedDatabase = { container: () => ({ item: () => item }) } as unknown as Database;
		const mockedAdapter = cosmosAdapter(mockedDatabase, {
			layout: { kind: "container-per-model" },
		})({ user: { additionalFields: { attempts: { type: "number" } } } });
		const mutation = mockedAdapter.incrementOne({
			model: "user",
			where: [{ field: "id", value: "contended-user" }],
			increment: { attempts: 1 },
			set: { name: "changed" },
		});

		if (status === 404) {
			await expect(mutation).resolves.toBeNull();
			expect(item.patch).toHaveBeenCalledTimes(1);
		} else {
			await expect(mutation).rejects.toThrow(/repeated concurrent changes/u);
			expect(item.read).toHaveBeenCalledTimes(16);
			expect(item.patch).toHaveBeenCalledTimes(16);
		}
	});

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
	it("composes increments selected by a non-id field", async () => {
		const id = await seed({ attempts: 0 });
		const contenders = 8;
		const results = await Promise.all(
			Array.from({ length: contenders }, () =>
				adapter.incrementOne({
					model: "user",
					where: [{ field: "email", value: `${id}@example.test` }],
					increment: { attempts: 1 },
				}),
			),
		);

		expect(results.every((result) => result !== null)).toBe(true);
		expect(await readCount(id)).toBe(contenders);
	}, 120_000);

	it.each([true, false])("honours the where bound with set=%s", async (withSet) => {
		const id = await seed({ attempts: 0 });
		const bound = 3;

		await Promise.all(
			Array.from({ length: 8 }, async () =>
				adapter.incrementOne({
					model: "user",
					where: [
						{ field: "id", operator: "eq", value: id, connector: "AND" },
						{ field: "attempts", operator: "lt", value: bound, connector: "AND" },
					],
					increment: { attempts: 1 },
					...(withSet ? { set: { name: "limited" } } : {}),
				}),
			),
		);

		expect(await readCount(id)).toBe(bound);
	}, 120_000);
});
