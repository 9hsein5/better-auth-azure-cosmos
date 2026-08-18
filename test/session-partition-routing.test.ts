import { randomUUID, createHash } from "node:crypto";

import { CosmosClient } from "@azure/cosmos";
import type { Database, FeedOptions, SqlQuerySpec } from "@azure/cosmos";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { cosmosAdapter, ensureAuthContainers, hashSessionToken } from "../src/index";

/**
 * Routing evidence for the `/tokenHash` session strategy.
 *
 * Whether a query was partition-scoped is not observable from its result, so every query is
 * recorded at the Cosmos container boundary along with the options it was issued with.
 */
const EMULATOR_ENDPOINT = "https://localhost:8081";
const EMULATOR_KEY =
	"C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

const endpoint = process.env.COSMOS_ENDPOINT ?? EMULATOR_ENDPOINT;
const key = process.env.COSMOS_KEY ?? EMULATOR_KEY;
const databaseId = `session-routing-${randomUUID().slice(0, 8)}`;

if (endpoint === EMULATOR_ENDPOINT) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const MODELS = ["user", "session", "account", "verification"];
const layout = {
	kind: "container-per-model",
	sessionPartition: "tokenHash",
	accountPartition: "accountKey",
} as const;

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

const sessionQueries = (): QueryRecord[] => queries.filter((record) => record.container === "session");

const since = (mark: number): QueryRecord[] => queries.slice(mark).filter((r) => r.container === "session");

let database: Database;
let adapter: ReturnType<ReturnType<typeof cosmosAdapter>>;

const newSession = async (userId: string) => {
	const token = `tok_${randomUUID()}${randomUUID()}`;
	const created = await adapter.create<Record<string, unknown>, { id: string; token: string }>({
		model: "session",
		data: {
			id: randomUUID(),
			token,
			userId,
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		},
		forceAllowId: true,
	});
	return created;
};

describe("session /tokenHash partition strategy", () => {
	beforeAll(async () => {
		const created = await client.databases.createIfNotExists({ id: databaseId });
		await ensureAuthContainers(created.database, { layout, models: MODELS });
		database = recordQueries(client.database(databaseId));
		adapter = cosmosAdapter(database, { layout })({} as never);
	}, 120_000);

	afterAll(async () => {
		await client.database(databaseId).delete();
	}, 60_000);

	it("creates the session container on /tokenHash and leaves other models on /id", async () => {
		const session = await client.database(databaseId).container("session").read();
		const user = await client.database(databaseId).container("user").read();
		expect(session.resource?.partitionKey?.paths).toStrictEqual(["/tokenHash"]);
		expect(user.resource?.partitionKey?.paths).toStrictEqual(["/id"]);
	}, 60_000);

	it("stores tokenHash as sha256 of the token and hides it from adapter output", async () => {
		const created = await newSession(randomUUID());

		// Raw storage: the derived field is present and correct.
		const { resources } = await client
			.database(databaseId)
			.container("session")
			.items.query<{ token: string; tokenHash: string }>({
				query: 'SELECT c["token"], c["tokenHash"] FROM c WHERE c.id = @id',
				parameters: [{ name: "@id", value: created.id }],
			})
			.fetchAll();
		const stored = resources[0];
		expect(stored?.tokenHash).toBe(createHash("sha256").update(stored?.token ?? "", "utf8").digest("hex"));
		expect(stored?.tokenHash).toBe(hashSessionToken(created.token));
		expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/u);

		// The partition key must never be the bearer credential itself.
		expect(stored?.tokenHash).not.toBe(created.token);

		// Better Auth must not see a storage-only field.
		expect(created).not.toHaveProperty("tokenHash");
	}, 60_000);

	it("scopes a session lookup by token to one partition, on hit and on miss", async () => {
		const created = await newSession(randomUUID());

		const hitMark = queries.length;
		const found = await adapter.findOne<{ id: string }>({
			model: "session",
			where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
		});
		const hit = since(hitMark);
		expect(found?.id).toBe(created.id);
		expect(hit).toHaveLength(1);
		expect(hit[0]?.scoped).toBe(true);
		expect(hit[0]?.partitionKey).toBe(hashSessionToken(created.token));
		// The equality predicate is retained: the hash routes, it does not replace the check.
		expect(hit[0]?.query).toContain('c["token"]');

		// An attacker-controlled unknown token must not become a container-wide fan-out.
		const missToken = `tok_${randomUUID()}${randomUUID()}`;
		const missMark = queries.length;
		const missing = await adapter.findOne({
			model: "session",
			where: [{ field: "token", operator: "eq", value: missToken, connector: "AND" }],
		});
		const miss = since(missMark);
		expect(missing).toBeNull();
		expect(miss).toHaveLength(1);
		expect(miss[0]?.scoped).toBe(true);
		expect(miss[0]?.partitionKey).toBe(hashSessionToken(missToken));
	}, 120_000);

	it("keeps token-addressed update and delete partition-scoped", async () => {
		const created = await newSession(randomUUID());
		const expected = hashSessionToken(created.token);

		const updateMark = queries.length;
		const refreshed = await adapter.update<{ id: string }>({
			model: "session",
			where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
			update: { expiresAt: new Date(Date.now() + 7_200_000) },
		});
		expect(refreshed?.id).toBe(created.id);
		for (const record of since(updateMark)) {
			expect(record.scoped).toBe(true);
			expect(record.partitionKey).toBe(expected);
		}

		// The token is immutable, so refreshing expiry must not move the partition.
		const { resources } = await client
			.database(databaseId)
			.container("session")
			.items.query<{ tokenHash: string }>({
				query: 'SELECT c["tokenHash"] FROM c WHERE c.id = @id',
				parameters: [{ name: "@id", value: created.id }],
			})
			.fetchAll();
		expect(resources[0]?.tokenHash).toBe(expected);

		const deleteMark = queries.length;
		await adapter.delete({
			model: "session",
			where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
		});
		for (const record of since(deleteMark)) {
			expect(record.scoped).toBe(true);
			expect(record.partitionKey).toBe(expected);
		}

		const gone = await adapter.findOne({
			model: "session",
			where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
		});
		expect(gone).toBeNull();
	}, 120_000);

	it("deletes only the target user's sessions and leaves every other user authenticable", async () => {
		const target = randomUUID();
		const bystander = randomUUID();
		const targetSessions = [await newSession(target), await newSession(target)];
		const bystanderSession = await newSession(bystander);

		const deleted = await adapter.deleteMany({
			model: "session",
			where: [{ field: "userId", operator: "eq", value: target, connector: "AND" }],
		});
		expect(deleted).toBe(targetSessions.length);

		for (const session of targetSessions) {
			const found = await adapter.findOne({
				model: "session",
				where: [{ field: "token", operator: "eq", value: session.token, connector: "AND" }],
			});
			expect(found).toBeNull();
		}

		const survivor = await adapter.findOne<{ id: string }>({
			model: "session",
			where: [{ field: "token", operator: "eq", value: bystanderSession.token, connector: "AND" }],
		});
		expect(survivor?.id).toBe(bystanderSession.id);
	}, 180_000);

	it("accepts that user-addressed reads are cross-partition, and records it", async () => {
		const userId = randomUUID();
		await newSession(userId);
		await newSession(userId);

		const mark = queries.length;
		const listed = await adapter.findMany<{ id: string }>({
			model: "session",
			where: [{ field: "userId", operator: "eq", value: userId, connector: "AND" }],
		});
		expect(listed).toHaveLength(2);

		// Documented trade, asserted rather than left implicit: this is the operation that pays for
		// the hot path being scoped.
		const listQueries = since(mark);
		expect(listQueries).toHaveLength(1);
		expect(listQueries[0]?.scoped).toBe(false);
	}, 120_000);

	it("refuses an update that would move a session to another partition", async () => {
		const created = await newSession(randomUUID());

		await expect(
			adapter.update<{ id: string }>({
				model: "session",
				where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
				update: { token: `tok_${randomUUID()}${randomUUID()}` },
			}),
		).rejects.toThrow(/partition/iu);

		// Refused, not half-applied: the session still resolves under the token it was stored with.
		const found = await adapter.findOne<{ id: string }>({
			model: "session",
			where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
		});
		expect(found?.id).toBe(created.id);
	}, 120_000);

	it("targets each partition for an explicit set of tokens rather than fanning out", async () => {
		const userId = randomUUID();
		const doomed = [await newSession(userId), await newSession(userId), await newSession(userId)];
		const survivor = await newSession(userId);
		const expected = doomed.map((session) => hashSessionToken(session.token)).sort();

		// The shape Better Auth uses to revoke a known set of sessions.
		const mark = queries.length;
		const deleted = await adapter.deleteMany({
			model: "session",
			where: [
				{
					field: "token",
					operator: "in",
					value: doomed.map((session) => session.token),
					connector: "AND",
				},
			],
		});
		expect(deleted).toBe(doomed.length);

		const issued = since(mark).filter((record) => record.query.includes("token"));
		expect(issued.every((record) => record.scoped)).toBe(true);
		expect([...new Set(issued.map((record) => String(record.partitionKey)))].sort()).toStrictEqual(
			expected,
		);

		for (const session of doomed) {
			const gone = await adapter.findOne({
				model: "session",
				where: [{ field: "token", operator: "eq", value: session.token, connector: "AND" }],
			});
			expect(gone).toBeNull();
		}
		const kept = await adapter.findOne<{ id: string }>({
			model: "session",
			where: [{ field: "token", operator: "eq", value: survivor.token, connector: "AND" }],
		});
		expect(kept?.id).toBe(survivor.id);
	}, 180_000);

	it("preserves tokenHash across every write path and never returns it", async () => {
		const created = await newSession(randomUUID());
		const expected = hashSessionToken(created.token);

		const storedHash = async (): Promise<string | undefined> => {
			const { resources } = await client
				.database(databaseId)
				.container("session")
				.items.query<{ tokenHash: string }>({
					query: 'SELECT c["tokenHash"] FROM c WHERE c.id = @id',
					parameters: [{ name: "@id", value: created.id }],
				})
				.fetchAll();
			return resources[0]?.tokenHash;
		};

		expect(await storedHash()).toBe(expected);
		expect(created).not.toHaveProperty("tokenHash");

		// A rolling refresh, then an unrelated field update: neither may drop the derived field.
		const refreshed = await adapter.update({
			model: "session",
			where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
			update: { expiresAt: new Date(Date.now() + 7_200_000) },
		});
		expect(await storedHash()).toBe(expected);
		expect(refreshed).not.toHaveProperty("tokenHash");

		const relabelled = await adapter.update({
			model: "session",
			where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
			update: { ipAddress: "203.0.113.9" },
		});
		expect(await storedHash()).toBe(expected);
		expect(relabelled).not.toHaveProperty("tokenHash");

		await adapter.updateMany({
			model: "session",
			where: [{ field: "id", operator: "eq", value: created.id, connector: "AND" }],
			update: { userAgent: "harness" },
		});
		expect(await storedHash()).toBe(expected);

		const read = await adapter.findOne({
			model: "session",
			where: [{ field: "token", operator: "eq", value: created.token, connector: "AND" }],
		});
		expect(read).not.toHaveProperty("tokenHash");
		const listed = await adapter.findMany({
			model: "session",
			where: [{ field: "id", operator: "eq", value: created.id, connector: "AND" }],
		});
		expect(listed[0]).not.toHaveProperty("tokenHash");
	}, 180_000);

	it("never puts a raw token in a partition key", () => {
		for (const record of sessionQueries()) {
			if (typeof record.partitionKey === "string") {
				expect(record.partitionKey).toMatch(/^[0-9a-f]{64}$/u);
			}
		}
	});
});
