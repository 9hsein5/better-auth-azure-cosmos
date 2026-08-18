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
): Promise<void> {
	let existing: PartitionKeyDefinition | undefined;
	try {
		const { resource } = await database.containers.createIfNotExists({ id, partitionKey });
		existing = resource?.partitionKey;
	} catch (error) {
		if (error instanceof ErrorResponse && error.code === CONFLICT) {
			return;
		}
		throw error;
	}

	const actual = existing?.paths ?? [];
	const expected = partitionKey.paths;
	if (actual.length === expected.length && actual.every((path, index) => path === expected[index])) {
		return;
	}
	throw new Error(
		`Container "${id}" is partitioned on ${actual.join(", ")}, but this layout needs ${expected.join(", ")}. A partition key cannot be changed after a container is created, so use a new container instead.`,
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
		await ensureContainer(database, container.id, container.partitionKey);
	}
	return required.map((container) => container.id);
}

/**
 * A partition key cannot be changed after a container is created, so an existing container with the
 * wrong one is a configuration error that must surface loudly. `createIfNotExists` returns the
 * existing definition unchanged, which would otherwise route every session write to the wrong key.
 */
function assertPartitionKey(
	containerId: string,
	expected: PartitionKeyDefinition,
	actual: PartitionKeyDefinition | undefined,
): void {
	const actualPaths = actual?.paths ?? [];
	const expectedPaths = expected.paths ?? [];
	const same =
		actualPaths.length === expectedPaths.length &&
		actualPaths.every((path, index) => path === expectedPaths[index]);

	if (!same) {
		throw new Error(
			`Container "${containerId}" already exists with partition key [${actualPaths.join(", ")}], but this layout requires [${expectedPaths.join(", ")}]. A partition key cannot be changed after creation: migrate to a new container instead.`,
		);
	}
}
