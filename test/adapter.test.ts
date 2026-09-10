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
 * Documented, non-secret key that every Cosmos DB emulator ships with.
 * Override both values to run the suite against a real account.
 */
const EMULATOR_ENDPOINT = "https://localhost:8081";
const EMULATOR_KEY =
	"C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==";

const endpoint = process.env.COSMOS_ENDPOINT ?? EMULATOR_ENDPOINT;
const key = process.env.COSMOS_KEY ?? EMULATOR_KEY;
const databaseId = process.env.COSMOS_DATABASE ?? "better-auth-adapter-tests";

if (endpoint === EMULATOR_ENDPOINT) {
	// The emulator serves a self-signed certificate.
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const client = new CosmosClient({ endpoint, key });

const { execute } = await testAdapter({
	adapter: async () => {
		const { database } = await client.databases.createIfNotExists({
			id: databaseId,
		});
		return cosmosAdapter(database, { layout: { kind: "single-container" } });
	},
	runMigrations: async () => {
		const { database } = await client.databases.createIfNotExists({
			id: databaseId,
		});
		await ensureAuthContainers(database, {
			layout: { kind: "single-container" },
		});
	},
	tests: [
		normalTestSuite(),
		authFlowTestSuite(),
		caseInsensitiveTestSuite(),
		joinsTestSuite(),
	],
	prefixTests: "single-container",
	async onFinish() {
		await client.database(databaseId).delete();
	},
});

execute();
