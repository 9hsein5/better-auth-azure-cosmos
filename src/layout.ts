import type { Container, Database, PartitionKey, PartitionKeyDefinition } from "@azure/cosmos";
import { PartitionKeyKind } from "@azure/cosmos";
import type { CleanedWhere } from "better-auth/adapters";
import type { AuthDocument } from "./document";
import {
	SESSION_MODEL,
	SESSION_TOKEN_FIELD,
	SESSION_TOKEN_HASH_FIELD,
	deriveSessionTokenHash,
	hashSessionToken,
	sessionTokenHashOf,
	type SessionPartitionStrategy,
} from "./partition";

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
			/**
			 * Partition strategy for the `session` container. `id` (the default)
			 * keeps every model on `/id`. `tokenHash` partitions sessions on
			 * `/tokenHash`, a stored SHA-256 of the session token, so that
			 * resolving a session credential by token is a single-partition query
			 * instead of an unscoped one.
			 *
			 * A partition key cannot be changed after a container is created, so
			 * this must be chosen before `ensureAuthContainers` runs.
			 *
			 * The trade is deliberate: token-addressed reads, updates and deletes
			 * become partition-scoped, while the lower-frequency user-addressed
			 * operations (list a user's sessions, revoke all of them) become
			 * cross-partition.
			 */
			readonly sessionPartition?: SessionPartitionStrategy;
	  };

export type CosmosLayout = {
	readonly container: (model: string) => Container;
	/** Partition key of a stored document, or of `{ id }` when only the id is known. */
	readonly partitionKeyOf: (model: string, document: AuthDocument) => PartitionKey;
	/** Fields written alongside the document to satisfy the partition key. */
	readonly stamp: (model: string, data: AuthDocument) => AuthDocument;
	/**
	 * Partition key a `where` pins the query to, or null when the query cannot be scoped and must
	 * be served across partitions.
	 */
	readonly scopeOf: (model: string, where: readonly CleanedWhere[]) => PartitionKey | null;
	/** Whether an `id` on its own identifies the partition, making a lookup a point read. */
	readonly addressableById: (model: string) => boolean;
	/** Containers this layout needs, and the partition key each must be created with. */
	readonly requiredContainers: (
		models: readonly string[],
	) => readonly { id: string; partitionKey: PartitionKeyDefinition }[];
	/** Restricts a query to one model, or null when the container is the model. */
	readonly modelField: string | null;
	readonly reservedFields: readonly string[];
};

/**
 * Only an AND-connected, case-sensitive equality on a string pins a partition. An OR-connected
 * clause can be satisfied by documents in other partitions, so scoping on it would silently drop
 * matches.
 */
function sessionScopeOf(where: readonly CleanedWhere[]): PartitionKey | null {
	for (const clause of where) {
		if (clause.connector === "OR") {
			continue;
		}
		if ((clause.operator ?? "eq") !== "eq" || clause.mode === "insensitive") {
			continue;
		}
		if (typeof clause.value !== "string") {
			continue;
		}
		if (clause.field === SESSION_TOKEN_HASH_FIELD) {
			return clause.value;
		}
		if (clause.field === SESSION_TOKEN_FIELD) {
			return hashSessionToken(clause.value);
		}
	}
	return null;
}

export function resolveLayout(
	database: Database,
	options: CosmosLayoutOptions = { kind: "single-container" },
): CosmosLayout {
	if (options.kind === "container-per-model") {
		const nameFor = options.containerName ?? ((model: string) => model);
		const hashesSessions = options.sessionPartition === "tokenHash";
		const isHashedSession = (model: string): boolean => hashesSessions && model === SESSION_MODEL;

		return {
			container: (model) => database.container(nameFor(model)),
			partitionKeyOf: (model, document) => {
				if (!isHashedSession(model)) {
					return document.id as PartitionKey;
				}
				const hash = sessionTokenHashOf(document);
				if (hash === null) {
					throw new Error(
						"The session container is partitioned by /tokenHash, but the document carries neither a tokenHash nor a token.",
					);
				}
				return hash;
			},
			stamp: (model, data) => {
				if (!isHashedSession(model)) {
					return {};
				}
				const hash = deriveSessionTokenHash(data);
				return hash === null ? {} : { [SESSION_TOKEN_HASH_FIELD]: hash };
			},
			scopeOf: (model, where) => (isHashedSession(model) ? sessionScopeOf(where) : null),
			addressableById: (model) => !isHashedSession(model),
			requiredContainers: (models) =>
				models.map((model) => ({
					id: nameFor(model),
					partitionKey: {
						paths: [isHashedSession(model) ? `/${SESSION_TOKEN_HASH_FIELD}` : "/id"],
					},
				})),
			modelField: null,
			// Storage-only, so Better Auth never sees it on a session it reads back.
			reservedFields: hashesSessions ? [SESSION_TOKEN_HASH_FIELD] : [],
		};
	}

	const containerName = options.containerName ?? DEFAULT_CONTAINER_NAME;
	const modelField = options.modelField ?? DEFAULT_MODEL_FIELD;
	const container = database.container(containerName);

	return {
		container: () => container,
		partitionKeyOf: (model, document) => [model, document.id as string],
		stamp: (model) => ({ [modelField]: model }),
		scopeOf: () => null,
		addressableById: () => true,
		// One container holds every model, so the requested models do not change what is created.
		requiredContainers: () => [
			{
				id: containerName,
				partitionKey: {
					paths: [`/${modelField}`, "/id"],
					kind: PartitionKeyKind.MultiHash,
					version: 2,
				},
			},
		],
		modelField,
		reservedFields: [modelField],
	};
}
