import { createHash, randomUUID } from "node:crypto";

import { CosmosClient } from "@azure/cosmos";
import type { Database, FeedOptions, SqlQuerySpec } from "@azure/cosmos";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cosmosAdapter, ensureAuthContainers, hashAccountKey } from "../src/index";

/**
 * Routing and enforcement evidence for the `/accountKeyHash` account strategy.
 *
 * Whether a query was partition-scoped is not observable from its result, so every query is
 * recorded at the Cosmos container boundary along with the options it was issued with.
 */
const EMULATOR_ENDPOINT = "https://localhost:8081";
const EMULATOR_KEY =
	"C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

const endpoint = process.env.COSMOS_ENDPOINT ?? EMULATOR_ENDPOINT;
const key = process.env.COSMOS_KEY ?? EMULATOR_KEY;
const databaseId = `account-routing-${randomUUID().slice(0, 8)}`;

if (endpoint === EMULATOR_ENDPOINT) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const MODELS = ["user", "account"];
const layout = { kind: "container-per-model", accountPartition: "accountKey" } as const;

const client = new CosmosClient({ endpoint, key });

type QueryRecord = {
	readonly container: string;
	readonly query: string;
	readonly partitionKey: unknown;
	readonly scoped: boolean;
};

const queries: QueryRecord[] = [];

/** Records every query issued, preserving SDK prototypes and binding forwarded members. */
function recordQueries(database: Database): Database {
	const bound = (target: object, property: string | symbol): unknown => {
		const value = Reflect.get(target, property, target);
		return typeof value === "function" ? value.bind(target) : value;
	};

	return new Proxy(database, {
		get(target, property) {
			if (property !== "container") return bound(target, property);
			return (id: string) => {
				const container = target.container(id);
				return new Proxy(container, {
					get(containerTarget, containerProperty) {
						if (containerProperty !== "items") return bound(containerTarget, containerProperty);
						const items = containerTarget.items;
						return new Proxy(items, {
							get(itemsTarget, itemsProperty) {
								if (itemsProperty !== "query") return bound(itemsTarget, itemsProperty);
								return (spec: SqlQuerySpec, options?: FeedOptions) => {
									queries.push({
										container: id,
										query: typeof spec === "string" ? spec : spec.query,
										partitionKey: options?.partitionKey,
										scoped: options?.partitionKey !== undefined,
									});
									return itemsTarget.query(spec, options);
								};
							},
						});
					},
				});
			};
		},
	});
}

const since = (mark: number): QueryRecord[] =>
	queries.slice(mark).filter((record) => record.container === "account");

let database: Database;
let adapter: ReturnType<ReturnType<typeof cosmosAdapter>>;

type AccountRow = { id: string; providerId: string; accountId: string; userId: string };

const newAccount = async (providerId: string, accountId: string, userId = randomUUID()) =>
	adapter.create<Record<string, unknown>, AccountRow>({
		model: "account",
		data: {
			id: randomUUID(),
			providerId,
			accountId,
			userId,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		forceAllowId: true,
	});

/** The exact shape `findAccountByKey` / `findAccountOwnerByKey` issue in Better Auth 1.7.3+. */
const identityWhere = (providerId: string, accountId: string) =>
	[
		{ field: "providerId", operator: "eq", value: providerId, connector: "AND" },
		{ field: "accountId", operator: "eq", value: accountId, connector: "AND" },
	] as const;

describe("account /accountKeyHash partition strategy", () => {
	beforeAll(async () => {
		const created = await client.databases.createIfNotExists({ id: databaseId });
		await ensureAuthContainers(created.database, { layout, models: MODELS });
		database = recordQueries(client.database(databaseId));
		adapter = cosmosAdapter(database, { layout })({} as never);
	}, 120_000);

	afterAll(async () => {
		await client.database(databaseId).delete();
	}, 60_000);

	it("stamps the stored hash from the identity pair and hides it from results", async () => {
		const providerId = `provider-${randomUUID().slice(0, 8)}`;
		const accountId = randomUUID();
		const created = await newAccount(providerId, accountId);

		expect(created).not.toHaveProperty("accountKeyHash");

		// Independent of hashAccountKey: the separator is a NUL byte between the two verbatim halves.
		const expected = createHash("sha256")
			.update([providerId, accountId].join(String.fromCharCode(0)), "utf8")
			.digest("hex");
		expect(hashAccountKey(providerId, accountId)).toBe(expected);

		const { resource } = await client
			.database(databaseId)
			.container("account")
			.item(created.id, expected)
			.read<Record<string, unknown>>();
		expect(resource?.accountKeyHash).toBe(expected);
	}, 120_000);

	it("rejects a second account with the same identity pair", async () => {
		const providerId = `provider-${randomUUID().slice(0, 8)}`;
		const accountId = randomUUID();
		await newAccount(providerId, accountId);

		// Same (providerId, accountId), different id and user: the partition-scoped unique key sees
		// both rows because both hash to the same partition.
		await expect(newAccount(providerId, accountId)).rejects.toMatchObject({ code: 409 });

		const rows = await adapter.findMany<AccountRow>({
			model: "account",
			where: [...identityWhere(providerId, accountId)],
			limit: 2,
		});
		expect(rows).toHaveLength(1);
	}, 120_000);

	it("resolves the identity pair as a single-partition query", async () => {
		const providerId = `provider-${randomUUID().slice(0, 8)}`;
		const accountId = randomUUID();
		const created = await newAccount(providerId, accountId);

		const mark = queries.length;
		const found = await adapter.findMany<AccountRow>({
			model: "account",
			where: [...identityWhere(providerId, accountId)],
			limit: 2,
		});
		expect(found.map((row) => row.id)).toStrictEqual([created.id]);

		const recorded = since(mark);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.scoped).toBe(true);
		expect(recorded[0]?.partitionKey).toBe(hashAccountKey(providerId, accountId));

		// A miss is routed the same way: the pair alone names the partition.
		const missMark = queries.length;
		const missing = await adapter.findMany<AccountRow>({
			model: "account",
			where: [...identityWhere(providerId, randomUUID())],
			limit: 2,
		});
		expect(missing).toHaveLength(0);
		expect(since(missMark).every((record) => record.scoped)).toBe(true);
	}, 120_000);

	it("lists a user's accounts across partitions, as documented", async () => {
		const userId = randomUUID();
		await newAccount(`provider-a-${randomUUID().slice(0, 6)}`, randomUUID(), userId);
		await newAccount(`provider-b-${randomUUID().slice(0, 6)}`, randomUUID(), userId);

		const mark = queries.length;
		const rows = await adapter.findMany<AccountRow>({
			model: "account",
			where: [{ field: "userId", operator: "eq", value: userId, connector: "AND" }],
		});
		expect(rows).toHaveLength(2);

		const recorded = since(mark);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.scoped).toBe(false);
	}, 120_000);

	it("refuses an update that would move an account to another partition", async () => {
		const providerId = `provider-${randomUUID().slice(0, 8)}`;
		const accountId = randomUUID();
		const created = await newAccount(providerId, accountId);

		await expect(
			adapter.update<AccountRow>({
				model: "account",
				where: [{ field: "id", operator: "eq", value: created.id, connector: "AND" }],
				update: { accountId: randomUUID() },
			}),
		).rejects.toThrow(/partition/iu);

		// Refused, not half-applied: the account still resolves under the pair it was stored with.
		const found = await adapter.findMany<AccountRow>({
			model: "account",
			where: [...identityWhere(providerId, accountId)],
			limit: 2,
		});
		expect(found.map((row) => row.id)).toStrictEqual([created.id]);
	}, 120_000);

	it("updates fields outside the identity pair in place", async () => {
		const providerId = `provider-${randomUUID().slice(0, 8)}`;
		const accountId = randomUUID();
		const created = await newAccount(providerId, accountId);

		const updated = await adapter.update<AccountRow & { scope: string }>({
			model: "account",
			where: [{ field: "id", operator: "eq", value: created.id, connector: "AND" }],
			update: { scope: "read:user" },
		});
		expect(updated?.scope).toBe("read:user");
		expect(updated).not.toHaveProperty("accountKeyHash");
	}, 120_000);
});
