import { randomUUID } from "node:crypto";

import { CosmosClient } from "@azure/cosmos";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ensureAuthContainers } from "../src/index";

/**
 * A partition key cannot be changed after a container is created, so adopting the session strategy
 * against an existing `/id` container would silently route every write to the wrong key. Bootstrap
 * must refuse rather than hand back the incompatible container.
 */
const EMULATOR_ENDPOINT = "https://localhost:8081";
const EMULATOR_KEY =
	"C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

const endpoint = process.env.COSMOS_ENDPOINT ?? EMULATOR_ENDPOINT;
const key = process.env.COSMOS_KEY ?? EMULATOR_KEY;

if (endpoint === EMULATOR_ENDPOINT) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const client = new CosmosClient({ endpoint, key });
const databases: string[] = [];

const tokenHashLayout = { kind: "container-per-model", sessionPartition: "tokenHash" } as const;
const idLayout = { kind: "container-per-model" } as const;

async function freshDatabase() {
	const id = `pk-guard-${randomUUID().slice(0, 8)}`;
	databases.push(id);
	const { database } = await client.databases.createIfNotExists({ id });
	return database;
}

const sessionPaths = async (databaseId: string): Promise<string[] | undefined> => {
	const { resource } = await client.database(databaseId).container("session").read();
	return resource?.partitionKey?.paths;
};

describe("session container partition-key validation", () => {
	beforeAll(() => {
		expect(endpoint).toBeTruthy();
	});

	afterAll(async () => {
		for (const id of databases) {
			await client
				.database(id)
				.delete()
				.catch(() => undefined);
		}
	}, 120_000);

	it("creates the session container on /tokenHash when none exists", async () => {
		const database = await freshDatabase();
		await ensureAuthContainers(database, { layout: tokenHashLayout, models: ["session"] });
		expect(await sessionPaths(database.id)).toStrictEqual(["/tokenHash"]);
	}, 120_000);

	it("is idempotent against an existing /tokenHash container", async () => {
		const database = await freshDatabase();
		await ensureAuthContainers(database, { layout: tokenHashLayout, models: ["session"] });
		await expect(
			ensureAuthContainers(database, { layout: tokenHashLayout, models: ["session"] }),
		).resolves.toStrictEqual(["session"]);
		expect(await sessionPaths(database.id)).toStrictEqual(["/tokenHash"]);
	}, 120_000);

	it("refuses an existing /id session container instead of returning it", async () => {
		const database = await freshDatabase();
		await ensureAuthContainers(database, { layout: idLayout, models: ["session"] });

		await expect(
			ensureAuthContainers(database, { layout: tokenHashLayout, models: ["session"] }),
		).rejects.toThrow(/partition key/iu);

		// The existing container is left exactly as it was; nothing is mutated or recreated.
		expect(await sessionPaths(database.id)).toStrictEqual(["/id"]);
	}, 120_000);

	it("refuses an existing container partitioned on something unexpected", async () => {
		const database = await freshDatabase();
		await database.containers.createIfNotExists({
			id: "session",
			partitionKey: { paths: ["/userId"] },
		});

		await expect(
			ensureAuthContainers(database, { layout: tokenHashLayout, models: ["session"] }),
		).rejects.toThrow(/partition key/iu);
		expect(await sessionPaths(database.id)).toStrictEqual(["/userId"]);
	}, 120_000);

	it("still expects /id for the default configuration", async () => {
		const database = await freshDatabase();
		await ensureAuthContainers(database, { layout: idLayout, models: ["session", "user"] });
		expect(await sessionPaths(database.id)).toStrictEqual(["/id"]);

		// And the default refuses a container someone created on /tokenHash.
		const other = await freshDatabase();
		await ensureAuthContainers(other, { layout: tokenHashLayout, models: ["session"] });
		await expect(
			ensureAuthContainers(other, { layout: idLayout, models: ["session"] }),
		).rejects.toThrow(/partition key/iu);
	}, 180_000);
});
