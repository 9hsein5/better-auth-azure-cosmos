import type { Container, Database, PartitionKey, PartitionKeyDefinition } from "@azure/cosmos";
import { PartitionKeyKind } from "@azure/cosmos";
import type { CleanedWhere } from "better-auth/adapters";
import type { AuthDocument } from "./document";
import {
	ACCOUNT_ID_FIELD,
	ACCOUNT_ISSUER_FIELD,
	ACCOUNT_KEY_HASH_FIELD,
	ACCOUNT_MODEL,
	SESSION_MODEL,
	SESSION_TOKEN_FIELD,
	SESSION_TOKEN_HASH_FIELD,
	accountKeyHashOf,
	deriveSessionTokenHash,
	hashAccountKey,
	hashSessionToken,
	sessionTokenHashOf,
	type AccountPartitionStrategy,
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
			/**
			 * Partition strategy for the `account` container. **Requires better-auth >= 1.7**,
			 * which is where the `issuer` field exists. `id` (the default) keeps it on
			 * `/id`. `accountKey` partitions on `/accountKeyHash`, a stored
			 * `sha256(issuer NUL accountId)`, and creates the container with a unique key
			 * policy on `["/issuer", "/accountId"]`.
			 *
			 * A Cosmos unique key is only enforced within a logical partition, so this is what
			 * makes the `["issuer", "accountId"]` uniqueness Better Auth declares actually
			 * enforceable. Resolving an account by issuer becomes partition-scoped; listing a
			 * user's accounts becomes cross-partition.
			 *
			 * Both the partition key and the unique key policy are immutable after a container
			 * is created, so this must be chosen up front.
			 */
			readonly accountPartition?: AccountPartitionStrategy;
	  };

export type CosmosLayout = {
	readonly container: (model: string) => Container;
	/** Partition key of a stored document, or of `{ id }` when only the id is known. */
	readonly partitionKeyOf: (model: string, document: AuthDocument) => PartitionKey;
	/** Fields written alongside the document to satisfy the partition key. */
	readonly stamp: (model: string, data: AuthDocument) => AuthDocument;
	/**
	 * Partition keys a `where` pins the query to, or null when the query cannot be scoped and must
	 * be served across partitions. More than one key means the query is answered per partition.
	 */
	readonly scopesOf: (
		model: string,
		where: readonly CleanedWhere[],
	) => readonly PartitionKey[] | null;
	/** Whether an `id` on its own identifies the partition, making a lookup a point read. */
	readonly addressableById: (model: string) => boolean;
	/**
	 * Whether the database enforces a declared unique constraint under this layout. True only
	 * when the partition key is derived from exactly the constrained fields and the container
	 * carries a matching unique key policy.
	 */
	readonly enforcesUnique: (model: string, fields: readonly string[]) => boolean;
	/** Containers this layout needs, and the partition key each must be created with. */
	readonly requiredContainers: (
		models: readonly string[],
	) => readonly {
		id: string;
		partitionKey: PartitionKeyDefinition;
		uniqueKeyPolicy?: { uniqueKeys: { paths: string[] }[] };
	}[];
	/** Restricts a query to one model, or null when the container is the model. */
	readonly modelField: string | null;
	readonly reservedFields: readonly string[];
};

/**
 * Partition keys a `where` pins the query to, or null when it must be served across partitions.
 *
 * Only AND-connected, case-sensitive clauses count. An OR-connected clause can be satisfied by
 * documents in other partitions, so scoping on it would silently drop matches.
 *
 * `token in [...]` is the shape Better Auth uses to revoke a known set of sessions. Every key is
 * derivable, so the query is answered as one targeted operation per partition instead of a single
 * unscoped one.
 */
function sessionScopesOf(where: readonly CleanedWhere[]): readonly PartitionKey[] | null {
	for (const clause of where) {
		if (clause.connector === "OR" || clause.mode === "insensitive") {
			continue;
		}
		const isToken = clause.field === SESSION_TOKEN_FIELD;
		const isHash = clause.field === SESSION_TOKEN_HASH_FIELD;
		if (!isToken && !isHash) {
			continue;
		}
		const operator = clause.operator ?? "eq";

		if (operator === "eq" && typeof clause.value === "string") {
			return [isHash ? clause.value : hashSessionToken(clause.value)];
		}

		if (
			operator === "in" &&
			Array.isArray(clause.value) &&
			clause.value.length > 0 &&
			clause.value.every((entry) => typeof entry === "string")
		) {
			const keys = (clause.value as string[]).map((entry) =>
				isHash ? entry : hashSessionToken(entry),
			);
			return [...new Set(keys)];
		}
	}
	return null;
}

function accountScopesOf(where: readonly CleanedWhere[]): readonly PartitionKey[] | null {
	let issuer: string | null = null;
	let accountId: string | null = null;

	for (const clause of where) {
		if (clause.connector === "OR" || clause.mode === "insensitive") {
			continue;
		}
		if ((clause.operator ?? "eq") !== "eq" || typeof clause.value !== "string") {
			continue;
		}
		if (clause.field === ACCOUNT_KEY_HASH_FIELD) {
			return [clause.value];
		}
		if (clause.field === ACCOUNT_ISSUER_FIELD) {
			issuer = clause.value;
		}
		if (clause.field === ACCOUNT_ID_FIELD) {
			accountId = clause.value;
		}
	}

	// Only the complete pair identifies a partition; `accountId` alone is not unique across issuers.
	return issuer !== null && accountId !== null ? [hashAccountKey(issuer, accountId)] : null;
}

/** The fields whose hash forms the account partition key, and thus the only enforceable pair. */
const ACCOUNT_KEY_FIELDS: readonly string[] = [ACCOUNT_ISSUER_FIELD, ACCOUNT_ID_FIELD];

export function resolveLayout(
	database: Database,
	options: CosmosLayoutOptions = { kind: "single-container" },
): CosmosLayout {
	if (options.kind === "container-per-model") {
		const nameFor = options.containerName ?? ((model: string) => model);
		const hashesSessions = options.sessionPartition === "tokenHash";
		const hashesAccounts = options.accountPartition === "accountKey";
		const isHashedAccount = (model: string): boolean => hashesAccounts && model === ACCOUNT_MODEL;
		const isHashedSession = (model: string): boolean => hashesSessions && model === SESSION_MODEL;

		return {
			container: (model) => database.container(nameFor(model)),
			partitionKeyOf: (model, document) => {
				if (isHashedAccount(model)) {
					const hash = accountKeyHashOf(document);
					if (hash === null) {
						throw new Error(
							"The account container is partitioned by /accountKeyHash, but the document carries neither an accountKeyHash nor an issuer and accountId.",
						);
					}
					return hash;
				}
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
				if (isHashedAccount(model)) {
					const hash = accountKeyHashOf(data);
					return hash === null ? {} : { [ACCOUNT_KEY_HASH_FIELD]: hash };
				}
				if (!isHashedSession(model)) {
					return {};
				}
				const hash = deriveSessionTokenHash(data);
				return hash === null ? {} : { [SESSION_TOKEN_HASH_FIELD]: hash };
			},
			scopesOf: (model, where) => {
				if (isHashedSession(model)) {
					return sessionScopesOf(where);
				}
				return isHashedAccount(model) ? accountScopesOf(where) : null;
			},
			addressableById: (model) => !isHashedSession(model) && !isHashedAccount(model),
			enforcesUnique: (model, fields) =>
				isHashedAccount(model) &&
				fields.length === ACCOUNT_KEY_FIELDS.length &&
				ACCOUNT_KEY_FIELDS.every((field) => fields.includes(field)),
			requiredContainers: (models) =>
				models.map((model) => ({
					id: nameFor(model),
					// The unique key is only enforceable because the partition key is derived from
					// exactly these paths, so every colliding row shares one logical partition.
					...(isHashedAccount(model)
						? {
								uniqueKeyPolicy: {
									uniqueKeys: [
										{ paths: [`/${ACCOUNT_ISSUER_FIELD}`, `/${ACCOUNT_ID_FIELD}`] },
									],
								},
							}
						: {}),
					partitionKey: {
						paths: [
						isHashedSession(model)
							? `/${SESSION_TOKEN_HASH_FIELD}`
							: isHashedAccount(model)
								? `/${ACCOUNT_KEY_HASH_FIELD}`
								: "/id",
					],
					},
				})),
			modelField: null,
			// Storage-only, so Better Auth never sees it on a session it reads back.
			reservedFields: [
				...(hashesSessions ? [SESSION_TOKEN_HASH_FIELD] : []),
				...(hashesAccounts ? [ACCOUNT_KEY_HASH_FIELD] : []),
			],
		};
	}

	const containerName = options.containerName ?? DEFAULT_CONTAINER_NAME;
	const modelField = options.modelField ?? DEFAULT_MODEL_FIELD;
	const container = database.container(containerName);

	return {
		container: () => container,
		partitionKeyOf: (model, document) => [model, document.id as string],
		stamp: (model) => ({ [modelField]: model }),
		scopesOf: () => null,
		addressableById: () => true,
		// A hierarchical `[docModel, id]` key gives every row its own partition, so a
		// partition-scoped unique key could never constrain two different ids.
		enforcesUnique: () => false,
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
