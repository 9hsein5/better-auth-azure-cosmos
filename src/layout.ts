import type { Container, Database, PartitionKey } from "@azure/cosmos";
import type { AuthDocument } from "./document";

export const DEFAULT_CONTAINER_NAME = "auth";
export const DEFAULT_MODEL_FIELD = "docModel";

export type CosmosLayoutOptions =
	| {
			/**
			 * Every model shares one container, partitioned on
			 * `[/{modelField}, /id]`. Cheapest option, and the one to use when
			 * throughput is shared across the database.
			 */
			readonly kind: "single-container";
			readonly containerName?: string;
			/**
			 * Field holding the model name. It must not collide with a field name
			 * used by any Better Auth model or plugin you enable.
			 */
			readonly modelField?: string;
	  }
	| {
			/**
			 * One container per model, partitioned on `/id`. Mirrors the table
			 * layout of the SQL adapters and isolates throughput per model.
			 */
			readonly kind: "container-per-model";
			readonly containerName?: (model: string) => string;
	  };

export type CosmosLayout = {
	readonly container: (model: string) => Container;
	readonly partitionKey: (model: string, id: string) => PartitionKey;
	/** Fields written alongside the document to satisfy the partition key. */
	readonly stamp: (model: string) => AuthDocument;
	/** Restricts a query to one model, or null when the container is the model. */
	readonly modelField: string | null;
	readonly reservedFields: readonly string[];
};

export function resolveLayout(
	database: Database,
	options: CosmosLayoutOptions = { kind: "single-container" },
): CosmosLayout {
	if (options.kind === "container-per-model") {
		const nameFor = options.containerName ?? ((model: string) => model);
		return {
			container: (model) => database.container(nameFor(model)),
			partitionKey: (_model, id) => id,
			stamp: () => ({}),
			modelField: null,
			reservedFields: [],
		};
	}

	const containerName = options.containerName ?? DEFAULT_CONTAINER_NAME;
	const modelField = options.modelField ?? DEFAULT_MODEL_FIELD;
	const container = database.container(containerName);

	return {
		container: () => container,
		partitionKey: (model, id) => [model, id],
		stamp: (model) => ({ [modelField]: model }),
		modelField,
		reservedFields: [modelField],
	};
}
