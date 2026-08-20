import type { Database, PartitionKeyDefinition } from "@azure/cosmos";
import { ErrorResponse } from "@azure/cosmos";
import { resolveLayout, type CosmosLayoutOptions } from "./layout";

const CONFLICT = 409;

export type EnsureContainersOptions = {
	readonly layout?: CosmosLayoutOptions;
	/** Models to create containers for. Required for the per-model layout. */
	readonly models?: readonly string[];
};

/**
 * `createIfNotExists` reads before it creates, so a container that appears twice in that window is
 * reported as a conflict rather than returned. It also returns an existing container as-is, and a
 * partition key cannot be changed afterwards, so the one already there is checked rather than
 * assumed.
 */
async function ensureContainer(
	database: Database,
	id: string,
	partitionKey: PartitionKeyDefinition,
	uniqueKeyPolicy?: { uniqueKeys: { paths: string[] }[] },
): Promise<void> {
	let existing: PartitionKeyDefinition | undefined;
	let existingUniqueKeys: string[] | undefined;
	try {
		const { resource } = await database.containers.createIfNotExists(
			uniqueKeyPolicy === undefined ? { id, partitionKey } : { id, partitionKey, uniqueKeyPolicy },
		);
		existing = resource?.partitionKey;
		existingUniqueKeys = resource?.uniqueKeyPolicy?.uniqueKeys?.map((k) => (k.paths ?? []).join(","));
	} catch (error) {
		if (error instanceof ErrorResponse && error.code === CONFLICT) {
			const { resource } = await database.container(id).read();
			existing = resource?.partitionKey;
			existingUniqueKeys = resource?.uniqueKeyPolicy?.uniqueKeys?.map((key) =>
				(key.paths ?? []).join(","),
			);
		} else {
			throw error;
		}
	}

	const actual = existing?.paths ?? [];
	const expected = partitionKey.paths;
	if (actual.length === expected.length && actual.every((path, index) => path === expected[index])) {
		assertUniqueKeys(id, uniqueKeyPolicy, existingUniqueKeys);
		return;
	}
	throw new Error(
		`Container "${id}" is partitioned on ${actual.join(", ")}, but this layout needs ${expected.join(", ")}. A partition key cannot be changed after a container is created, so use a new container instead.`,
	);
}

/** A unique key policy is as immutable as the partition key, so a mismatch is equally fatal. */
function assertUniqueKeys(
	id: string,
	expected: { uniqueKeys: { paths: string[] }[] } | undefined,
	actual: string[] | undefined,
): void {
	if (expected === undefined) {
		return;
	}
	const want = expected.uniqueKeys.map((key) => key.paths.join(",")).sort();
	const have = [...(actual ?? [])].sort();
	if (want.length === have.length && want.every((key, index) => key === have[index])) {
		return;
	}
	throw new Error(
		`Container "${id}" has unique key policy [${have.join(" | ")}], but this layout needs [${want.join(" | ")}]. A unique key policy cannot be changed after a container is created, so use a new container instead.`,
	);
}

/**
 * Creates the containers the adapter expects.
 *
 * A partition key cannot be changed after a container is created, so run this
 * once against a new database rather than creating containers by hand.
 */
export async function ensureAuthContainers(
	database: Database,
	options: EnsureContainersOptions = {},
): Promise<string[]> {
	const layout = options.layout ?? { kind: "single-container" };
	const models = options.models ?? [];

	if (layout.kind === "container-per-model" && models.length === 0) {
		throw new Error(
			"ensureAuthContainers requires `models` when using the container-per-model layout.",
		);
	}

	const required = resolveLayout(database, layout).requiredContainers(models);
	for (const container of required) {
		await ensureContainer(database, container.id, container.partitionKey, container.uniqueKeyPolicy);
	}
	return required.map((container) => container.id);
}
