import type { Database } from "@azure/cosmos";
import { PartitionKeyKind } from "@azure/cosmos";
import {
	DEFAULT_CONTAINER_NAME,
	DEFAULT_MODEL_FIELD,
	type CosmosLayoutOptions,
} from "./layout";

export type EnsureContainersOptions = {
	readonly layout?: CosmosLayoutOptions;
	/** Models to create containers for. Required for the per-model layout. */
	readonly models?: readonly string[];
};

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

	if (layout.kind === "container-per-model") {
		const models = options.models ?? [];
		if (models.length === 0) {
			throw new Error(
				"ensureAuthContainers requires `models` when using the container-per-model layout.",
			);
		}
		const nameFor = layout.containerName ?? ((model: string) => model);
		const created: string[] = [];
		for (const model of models) {
			const id = nameFor(model);
			await database.containers.createIfNotExists({
				id,
				partitionKey: { paths: ["/id"] },
			});
			created.push(id);
		}
		return created;
	}

	const id = layout.containerName ?? DEFAULT_CONTAINER_NAME;
	const modelField = layout.modelField ?? DEFAULT_MODEL_FIELD;
	await database.containers.createIfNotExists({
		id,
		partitionKey: {
			paths: [`/${modelField}`, "/id"],
			kind: PartitionKeyKind.MultiHash,
			version: 2,
		},
	});
	return [id];
}
