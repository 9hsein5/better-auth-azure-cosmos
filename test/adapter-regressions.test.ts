import { randomUUID } from "node:crypto";
import { CosmosClient, ErrorResponse } from "@azure/cosmos";
import type { Database } from "@azure/cosmos";
import type { BetterAuthOptions } from "better-auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cosmosAdapter, ensureAuthContainers } from "../src/index";
import type { CosmosLayoutOptions } from "../src/layout";

const EMULATOR_ENDPOINT = "https://localhost:8081";
const EMULATOR_KEY =
	"C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";
const endpoint = process.env.COSMOS_ENDPOINT ?? EMULATOR_ENDPOINT;
if (endpoint === EMULATOR_ENDPOINT) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}
const client = new CosmosClient({ endpoint, key: process.env.COSMOS_KEY ?? EMULATOR_KEY });
const databaseId = `contract-regressions-${randomUUID()}`;
let database: Database;
type Adapter = ReturnType<ReturnType<typeof cosmosAdapter>>;

const layouts: { name: string; layout: CosmosLayoutOptions }[] = [
	{ name: "single", layout: { kind: "single-container", containerName: "regression_single" } },
	{
		name: "id",
		layout: { kind: "container-per-model", containerName: (model) => `regression_id_${model}` },
	},
	{
		name: "hashed",
		layout: {
			kind: "container-per-model",
			containerName: (model) => `regression_hashed_${model}`,
			sessionPartition: "tokenHash",
			accountPartition: "accountKey",
			rateLimitPartition: "key",
		},
	},
];
const options: BetterAuthOptions = {
	rateLimit: { storage: "database" },
	user: {
		additionalFields: {
			attempts: { type: "number", required: false },
			_custom: { type: "string", required: false },
			tokenHash: { type: "string", required: false },
			accountKeyHash: { type: "string", required: false },
			keyHash: { type: "string", required: false },
		},
	},
};

async function seed(adapter: Adapter, values: Record<string, unknown> = {}) {
	const id = randomUUID();
	return adapter.create<Record<string, unknown>, { id: string; email: string }>({
		model: "user",
		data: { id, email: `${id}@example.test`, name: "original", attempts: 0, ...values },
		forceAllowId: true,
	});
}

async function storedUser(layout: CosmosLayoutOptions, id: string) {
	const container = layout.kind === "single-container"
		? database.container(layout.containerName ?? "auth")
		: database.container(layout.containerName?.("user") ?? "user");
	const partitionKey = layout.kind === "single-container" ? ["user", id] : id;
	return (await container.item(id, partitionKey).read<Record<string, unknown>>()).resource;
}

async function expectRoundTrip(adapter: Adapter, id: string, values: Record<string, unknown>) {
	const where = [{ field: "id", value: id }];
	expect(await adapter.findOne({ model: "user", where })).toMatchObject(values);
	expect(await adapter.findMany({ model: "user", where })).toEqual([
		expect.objectContaining(values),
	]);
	expect(await adapter.update({ model: "user", where, update: { attempts: 1 } }))
		.toMatchObject(values);
	expect(await adapter.incrementOne({ model: "user", where, increment: { attempts: 1 } }))
		.toMatchObject(values);
	expect(await adapter.consumeOne({ model: "user", where })).toMatchObject(values);
}

function bound(target: object, key: string | symbol): unknown {
	const value: unknown = Reflect.get(target, key, target);
	return typeof value === "function" ? value.bind(target) : value;
}

// Interleave a real write after selection but immediately before the conditional delete.
function beforeDelete(database: Database, hook: (id: string) => Promise<void>, repeat = false): Database {
	let intercepted = false;
	return new Proxy(database, {
		get(target, key) {
			if (key !== "container") return bound(target, key);
			return (containerId: string) => {
				const container = target.container(containerId);
				return new Proxy(container, {
					get(containerTarget, containerKey) {
						if (containerKey !== "item") return bound(containerTarget, containerKey);
						return (...args: Parameters<typeof container.item>) => {
							const item = container.item(...args);
							return new Proxy(item, {
								get(itemTarget, itemKey) {
									if (itemKey !== "delete") return bound(itemTarget, itemKey);
									return async (...deleteArgs: Parameters<typeof item.delete>) => {
										if (repeat || !intercepted) {
											intercepted = true;
											await hook(args[0]);
										}
										return item.delete(...deleteArgs);
									};
								},
							});
						};
					},
				});
			};
		},
	});
}

beforeAll(async () => {
	database = (await client.databases.createIfNotExists({ id: databaseId })).database;
	for (const { layout } of layouts) {
		await ensureAuthContainers(database, {
			layout,
			models: ["user", "session", "account", "verification", "rateLimit", "profiles"],
		});
	}
});

afterAll(async () => {
	try {
		if (database) await database.delete();
	} finally {
		client.dispose();
	}
});

describe.each(layouts)("$name adapter regressions", ({ layout }) => {
	const adapter = () => cosmosAdapter(database, { layout })(options);

	it("preserves underscore-prefixed custom fields on every result path", async () => {
		const a = adapter();
		const values = { _custom: "stored-value" };
		const created = await seed(a, values);
		expect(await storedUser(layout, created.id)).toMatchObject(values);
		await expectRoundTrip(a, created.id, values);
	});

	it("preserves a core field mapped to an underscore-prefixed stored name", async () => {
		const a = cosmosAdapter(database, { layout })({
			...options,
			user: { ...options.user, fields: { name: "_displayName" } },
		});
		const created = await seed(a, { name: "display-value" });
		expect(await storedUser(layout, created.id)).toMatchObject({ _displayName: "display-value" });
		await expectRoundTrip(a, created.id, { name: "display-value" });
	});

	it("does not reserve another model's hash fields on user records", async () => {
		const a = adapter();
		const values = { tokenHash: "user-token", accountKeyHash: "user-account", keyHash: "user-key" };
		const created = await seed(a, values);
		expect(await storedUser(layout, created.id)).toMatchObject(values);
		await expectRoundTrip(a, created.id, values);
	});

	it("maps predicates, projections and ordering exactly once", async () => {
		const a = cosmosAdapter(database, { layout })({
			user: { fields: { name: "email", email: "email_address" } },
		});
		const value = `a-${randomUUID()}@example.test`;
		const expected = await seed(a, { name: value, email: `z-${randomUUID()}@example.test` });
		const other = await seed(a, { name: "z-other", email: value });
		const where = [{ field: "name", value }];
		expect(await a.findOne({ model: "user", where })).toMatchObject({ id: expected.id });
		expect(await a.count({ model: "user", where })).toBe(1);
		expect(await a.findMany({
			model: "user",
			where: [{ field: "id", operator: "in", value: [expected.id, other.id] }],
			select: ["id", "name"],
			sortBy: { field: "name", direction: "asc" },
		})).toEqual([
			{ id: expected.id, name: value },
			{ id: other.id, name: "z-other" },
		]);
		expect(await a.update({ model: "user", where, update: { name: "renamed" } }))
			.toMatchObject({ id: expected.id, name: "renamed" });
		expect(await a.updateMany({
			model: "user",
			where: [{ field: "name", value: "renamed" }],
			update: { name: value },
		})).toBe(1);
		expect(await a.deleteMany({ model: "user", where })).toBe(1);
		expect(await a.findOne({ model: "user", where: [{ field: "id", value: other.id }] }))
			.toMatchObject({ id: other.id });
	});

	it("maps counter increments and absolute assignments exactly once", async () => {
		const a = cosmosAdapter(database, { layout })({
			user: {
				additionalFields: {
					score: { type: "number", fieldName: "balance" },
					balance: { type: "number", fieldName: "accountBalance" },
				},
			},
		});
		const created = await seed(a, { score: 0, balance: 10 });
		const where = [{ field: "id", value: created.id }];
		expect(await a.incrementOne({ model: "user", where, increment: { score: 1 } }))
			.toMatchObject({ score: 1, balance: 10 });
		expect(await a.incrementOne({ model: "user", where, increment: {}, set: { score: 7 } }))
			.toMatchObject({ score: 7, balance: 10 });
	});

	it("joins on stored field names while preserving logical relationship identity", async () => {
		const a = cosmosAdapter(database, { layout })({
			advanced: { database: { joins: true } },
			plugins: [{
				id: "mapped-profile",
				schema: {
					profile: {
						modelName: "profiles",
						fields: {
							ownerId: {
								type: "string",
								fieldName: "label",
								unique: true,
								references: { model: "user", field: "id" },
							},
							label: { type: "string", fieldName: "displayLabel" },
						},
					},
				},
			}],
		});
		const user = await seed(a);
		await a.create({ model: "profile", data: { ownerId: user.id, label: "linked" } });
		const request = {
			model: "user",
			where: [{ field: "id", value: user.id }],
			join: { profile: true },
			select: ["email"],
		};
		const expected = { email: user.email, profile: { ownerId: user.id, label: "linked" } };
		expect(await a.findOne(request)).toMatchObject(expected);
		const users = await a.findMany(request);
		expect(users).toHaveLength(1);
		expect(users[0]).toMatchObject(expected);
	});

	it.each(["delete", "deleteMany"] as const)(
		"%s preserves a row whose predicate stopped matching",
		async (method) => {
			const a = adapter();
			const created = await seed(a, { name: "delete-me" });
			const racing = cosmosAdapter(beforeDelete(database, async () => {
				await a.update({
					model: "user",
					where: [{ field: "id", value: created.id }],
					update: { name: "retain-me" },
				});
			}), { layout })(options);
			const result = await racing[method]({
				model: "user",
				where: [{ field: "id", value: created.id }, { field: "name", value: "delete-me" }],
			});
			if (method === "deleteMany") expect(result).toBe(0);
			expect(await a.findOne({ model: "user", where: [{ field: "id", value: created.id }] }))
				.toMatchObject({ name: "retain-me" });
		},
	);

	it.each(["delete", "deleteMany"] as const)(
		"%s retries concurrent changes while its complete predicate still matches",
		async (method) => {
			const a = adapter();
			const created = await seed(a);
			const where = [{ field: "id", value: created.id }];
			const racing = cosmosAdapter(beforeDelete(database, async () => {
				await a.update({ model: "user", where, update: { name: "concurrently-updated" } });
			}), { layout })(options);
			const result = await racing[method]({ model: "user", where });
			if (method === "deleteMany") expect(result).toBe(1);
			expect(await a.findOne({ model: "user", where })).toBeNull();
		},
	);

	it("surfaces missing-container errors on point reads as well as queries", async () => {
		const missingName = `not-created-${randomUUID()}`;
		const missingLayout: CosmosLayoutOptions = layout.kind === "single-container"
			? { ...layout, containerName: missingName }
			: { ...layout, containerName: () => missingName };
		const a = cosmosAdapter(database, { layout: missingLayout })(options);
		await expect(a.findOne({
			model: "user",
			where: [{ field: "id", value: randomUUID() }],
		})).rejects.toMatchObject({ code: 404 });
		const queryError: unknown = await a.findOne({
			model: "user",
			where: [{ field: "email", value: "missing@example.test" }],
		}).catch((error: unknown) => error);
		expect(queryError).toBeInstanceOf(ErrorResponse);
		// EN20261019 returns 400/1003 for a missing collection's query plan, rather than 404.
		if (queryError instanceof ErrorResponse && queryError.code === 400) {
			expect(queryError.substatus).toBe(1003);
		} else {
			expect(queryError).toMatchObject({ code: 404 });
		}
	});

	it("returns null for a missing item in an existing container", async () => {
		expect(await adapter().findOne({
			model: "user",
			where: [{ field: "id", value: randomUUID() }],
		})).toBeNull();
	});
});

describe.each(layouts.filter(({ name }) => name !== "hashed"))(
	"$name canonical model-name collision",
	({ layout }) => {
		it("preserves logical identity for predicates, projections and ordering", async () => {
			const a = cosmosAdapter(database, { layout })({
				user: { modelName: "account", fields: { email: "mailbox" } },
				account: { modelName: "linkedAccount" },
			});
			const created = await seed(a);
			const where = [{ field: "email", value: created.email }];
			const select = ["id", "email"];
			const expected = { id: created.id, email: created.email };
			expect(await a.findOne({ model: "user", where, select })).toEqual(expected);
			expect(await a.findMany({
				model: "user", where, select, sortBy: { field: "email", direction: "asc" },
			})).toEqual([expected]);
		});
	},
);

describe("conditional delete failure handling", () => {
	const layout = { kind: "container-per-model", containerName: (model: string) => `regression_id_${model}` } as const;

	it("does not switch to another matching row after the selected row stops matching", async () => {
		const a = cosmosAdapter(database, { layout })(options);
		const name = randomUUID();
		const first = await seed(a, { name });
		const second = await seed(a, { name });
		const racing = cosmosAdapter(beforeDelete(database, async (id) => {
			await a.update({
				model: "user",
				where: [{ field: "id", value: id }],
				update: { name: "retain-me" },
			});
		}), { layout })(options);

		await racing.delete({ model: "user", where: [{ field: "name", value: name }] });
		expect(await a.findMany({
			model: "user",
			where: [{ field: "id", operator: "in", value: [first.id, second.id] }],
		})).toHaveLength(2);
		expect(await a.count({ model: "user", where: [{ field: "name", value: name }] })).toBe(1);
	});

	it.each(["delete", "deleteMany"] as const)("%s throws after bounded contention", async (method) => {
		const a = cosmosAdapter(database, { layout })(options);
		const created = await seed(a);
		const where = [{ field: "id", value: created.id }];
		let attempts = 0;
		const racing = cosmosAdapter(beforeDelete(database, async () => {
			attempts += 1;
			await a.update({ model: "user", where, update: { name: `revision-${attempts}` } });
		}, true), { layout })(options);
		await expect(racing[method]({ model: "user", where })).rejects.toThrow(/delete.*concurrent/iu);
		expect(attempts).toBe(16);
		expect(await a.findOne({ model: "user", where })).not.toBeNull();
	});

	it("does not hide non-conflict delete errors", async () => {
		const a = cosmosAdapter(database, { layout })(options);
		const created = await seed(a);
		const where = [{ field: "id", value: created.id }];
		const error = new ErrorResponse("unavailable");
		error.code = 503;
		const failing = cosmosAdapter(beforeDelete(database, async () => {
			throw error;
		}), { layout })(options);
		await expect(failing.deleteMany({ model: "user", where })).rejects.toBe(error);
		expect(await a.findOne({ model: "user", where })).not.toBeNull();
	});
});
