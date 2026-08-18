import { randomUUID } from "node:crypto";

import { CosmosClient } from "@azure/cosmos";
import {
	authFlowTestSuite,
	caseInsensitiveTestSuite,
	joinsTestSuite,
	normalTestSuite,
	testAdapter,
} from "@better-auth/test-utils/adapter";
import { cosmosAdapter, ensureAuthContainers } from "../src/index";

/**
 * The same official conformance suites the single-container layout runs, against the layout that
 * partitions sessions by `/tokenHash`. Partitioning is storage-only, so Better Auth's expectations
 * are used unmodified: if the strategy changed observable adapter behaviour, these would fail.
 */
const EMULATOR_ENDPOINT = "https://localhost:8081";
const EMULATOR_KEY =
	"C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

const endpoint = process.env.COSMOS_ENDPOINT ?? EMULATOR_ENDPOINT;
const key = process.env.COSMOS_KEY ?? EMULATOR_KEY;
// Fresh per run: `runMigrations` is invoked once per suite, so it must be idempotent and must not
// delete a database that a sibling suite is still using.
const databaseId = `session-pk-${randomUUID().slice(0, 8)}`;

if (endpoint === EMULATOR_ENDPOINT) {
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/**
 * `container-per-model` needs a container for every model a suite touches, including the ones the
 * conformance suites define themselves and the physical names they remap to. `single-container`
 * needs none of this, which is why it never surfaced before.
 */
const MODELS = [
	"user",
	"session",
	"account",
	"verification",
	"member",
	"organization",
	"invitation",
	"team",
	"teamMember",
	"testModel",
	"oneToOneTable",
	"one_to_one_table",
	"user_custom",
	"user_table",
];
const layout = { kind: "container-per-model", sessionPartition: "tokenHash" } as const;

const client = new CosmosClient({ endpoint, key });

const { execute } = await testAdapter({
	adapter: async () => {
		const { database } = await client.databases.createIfNotExists({ id: databaseId });
		return cosmosAdapter(database, { layout });
	},
	runMigrations: async () => {
		const { database } = await client.databases.createIfNotExists({ id: databaseId });
		await ensureAuthContainers(database, { layout, models: MODELS });
	},
	tests: [
		normalTestSuite(),
		authFlowTestSuite(),
		caseInsensitiveTestSuite(),
		joinsTestSuite(),
	],
	prefixTests: "session-tokenhash",
	async onFinish() {
		await client.database(databaseId).delete();
	},
});

execute();
