import type {
	Container,
	Database,
	PartitionKey,
	PatchOperation,
	SqlParameter,
	SqlQuerySpec,
} from "@azure/cosmos";
import { ErrorResponse } from "@azure/cosmos";
import type { BetterAuthOptions } from "better-auth";
import { createAdapterFactory } from "better-auth/adapters";
import type {
	AdapterFactory,
	CleanedWhere,
	DBAdapterDebugLogOption,
	JoinConfig,
} from "better-auth/adapters";
import {
	toAuthDocument,
	type AuthDocument,
	type AuthFieldValue,
	type StoredAuthDocument,
} from "./document";
import {
	ACCOUNT_KEY_FIELDS,
	resolveLayout,
	type CosmosLayout,
	type CosmosLayoutOptions,
} from "./layout";
import {
	ACCOUNT_MODEL,
	RATE_LIMIT_KEY_FIELD,
	RATE_LIMIT_MODEL,
	SESSION_MODEL,
	SESSION_TOKEN_FIELD,
} from "./partition";
import {
	buildWherePredicate,
	createParameterCollector,
	quoteFieldPath,
	type FieldMapper,
} from "./where";

const NOT_FOUND = 404;
const PRECONDITION_FAILED = 412;
const MAX_INCREMENT_ATTEMPTS = 16;

export type CosmosAdapterConfig = {
	readonly layout?: CosmosLayoutOptions;
	readonly debugLogs?: DBAdapterDebugLogOption;
};

type QueryShape = {
	readonly where: readonly CleanedWhere[];
	readonly sortBy?: { readonly field: string; readonly direction: "asc" | "desc" };
	readonly limit?: number;
	readonly offset?: number;
	/** Tallies in the engine instead of projecting rows, so only the count crosses the wire. */
	readonly count?: boolean;
	/** Already mapped to stored field names. */
	readonly select?: readonly string[];
};

/**
 * Applied even when the query already projected, because the point-read path
 * cannot project and joins have to be fetched whole before being trimmed.
 */
function projectDocument(
	document: AuthDocument,
	select: readonly string[] | undefined,
	keep: readonly string[] = [],
): AuthDocument {
	if (!select || select.length === 0) {
		return document;
	}
	const allowed = new Set([...select, ...keep]);
	const result: AuthDocument = {};
	for (const [key, value] of Object.entries(document)) {
		if (allowed.has(key)) {
			result[key] = value;
		}
	}
	return result;
}

function isStatus(error: unknown, status: number): boolean {
	return error instanceof ErrorResponse && error.code === status;
}

function samePartition(a: PartitionKey, b: PartitionKey): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, index) => value === b[index])
		);
	}
	return a === b;
}

/**
 * Cosmos cannot move a document between partitions, so an update that would re-key one is refused
 * rather than written back under its old key, where the new key would never find it again.
 */
function assertPartitionUnchanged(
	layout: CosmosLayout,
	model: string,
	stored: StoredAuthDocument,
	next: AuthDocument,
): void {
	const from = layout.partitionKeyOf(model, stored);
	const to = layout.partitionKeyOf(model, next);
	if (samePartition(from, to)) {
		return;
	}
	throw new Error(
		`Updating this ${model} would move it to another partition, which Cosmos cannot do in place. Delete the document and create it again instead.`,
	);
}

function buildQuery(
	layout: CosmosLayout,
	model: string,
	shape: QueryShape,
	mapField: FieldMapper,
): { query: string; parameters: SqlParameter[] } {
	const collector = createParameterCollector("p");
	const clauses: string[] = [];

	if (layout.modelField !== null) {
		clauses.push(`${quoteFieldPath(layout.modelField)} = @model`);
	}

	const predicate = buildWherePredicate(shape.where, collector, mapField);
	if (predicate.length > 0) {
		clauses.push(predicate);
	}

	let query = "SELECT";
	query += shape.count
		? " VALUE COUNT(1)"
		: shape.select && shape.select.length > 0
			? ` ${shape.select.map((field) => quoteFieldPath(field)).join(", ")}`
			: " *";
	query += " FROM c";
	if (clauses.length > 0) {
		query += ` WHERE ${clauses.join(" AND ")}`;
	}

	if (shape.sortBy) {
		const direction = shape.sortBy.direction === "desc" ? "DESC" : "ASC";
		query += ` ORDER BY ${quoteFieldPath(mapField(shape.sortBy.field))} ${direction}`;
	}

	const hasLimit = typeof shape.limit === "number" && Number.isFinite(shape.limit);
	const offset = shape.offset ?? 0;
	if (hasLimit || offset > 0) {
		// Cosmos rejects OFFSET without LIMIT, so an unbounded page still needs a ceiling.
		const limit = hasLimit ? shape.limit : Number.MAX_SAFE_INTEGER;
		query += ` OFFSET ${offset} LIMIT ${limit}`;
	}

	const parameters: SqlParameter[] = [];
	if (layout.modelField !== null) {
		parameters.push({ name: "@model", value: model });
	}
	for (const binding of collector.bindings) {
		parameters.push({ name: binding.name, value: binding.value });
	}

	return { query, parameters };
}

async function queryDocuments(
	layout: CosmosLayout,
	model: string,
	shape: QueryShape,
	mapField: FieldMapper,
): Promise<StoredAuthDocument[]> {
	const spec = buildQuery(layout, model, shape, mapField);
	const scopes = layout.scopesOf(model, shape.where);

	// Paging has no defined order across partitions, so a multi-partition fan-out cannot honour it;
	// such a query is left unscoped rather than answered from an arbitrary slice of each partition.
	const pageable =
		shape.limit !== undefined || shape.offset !== undefined || shape.sortBy !== undefined;
	const routed = scopes !== null && scopes.length > 1 && pageable ? null : scopes;

	return fetchAll<StoredAuthDocument>(layout, model, spec, routed);
}

/**
 * Counting in the engine keeps the matched rows on the server: only one tally per partition
 * crosses the wire, so the cost stops scaling with how many documents match.
 */
/** Patch paths are interpolated, so the field name is validated the same way SQL paths are. */
function patchPath(field: string): string {
	quoteFieldPath(field);
	return `/${field}`;
}

async function countDocuments(
	layout: CosmosLayout,
	model: string,
	where: readonly CleanedWhere[],
	mapField: FieldMapper,
): Promise<number> {
	const spec = buildQuery(layout, model, { where, count: true }, mapField);
	const tallies = await fetchAll<number>(layout, model, spec, layout.scopesOf(model, where));
	return tallies.reduce((total, tally) => total + tally, 0);
}

/**
 * Runs a spec once per partition the `where` pins, or once unscoped when it pins none.
 *
 * The per-partition form is not atomic and does not claim to be -- Cosmos cannot transact across
 * logical partitions -- but every read is routed rather than broadcast.
 */
async function fetchAll<T>(
	layout: CosmosLayout,
	model: string,
	spec: SqlQuerySpec,
	scopes: readonly PartitionKey[] | null,
): Promise<T[]> {
	const container: Container = layout.container(model);

	if (scopes === null) {
		// Unscoped: the query must probe every physical partition's index, so the plan is fetched
		// immediately rather than after the gateway path fails and retries.
		const response = await container.items.query<T>(spec, { forceQueryPlan: true }).fetchAll();
		return response.resources;
	}

	const pages = await Promise.all(
		scopes.map(async (partitionKey) => {
			const response = await container.items.query<T>(spec, { partitionKey }).fetchAll();
			return response.resources;
		}),
	);
	return pages.flat();
}

/**
 * A `where` that pins the id lets Cosmos do a point read, which is the only
 * single-partition path available under either layout.
 */
function pointReadId(where: readonly CleanedWhere[]): string | null {
	if (where.length !== 1) {
		return null;
	}
	const [clause] = where;
	if (
		!clause ||
		clause.field !== "id" ||
		(clause.operator ?? "eq") !== "eq" ||
		clause.mode === "insensitive" ||
		typeof clause.value !== "string"
	) {
		return null;
	}
	return clause.value;
}

async function readOne(
	layout: CosmosLayout,
	model: string,
	where: readonly CleanedWhere[],
	mapField: FieldMapper,
): Promise<StoredAuthDocument | null> {
	const id = layout.addressableById(model) ? pointReadId(where) : null;
	if (id !== null) {
		try {
			const response = await layout
				.container(model)
				.item(id, layout.partitionKeyOf(model, { id }))
				.read<StoredAuthDocument>();
			return response.resource ?? null;
		} catch (error) {
			if (isStatus(error, NOT_FOUND)) {
				return null;
			}
			throw error;
		}
	}

	const documents = await queryDocuments(
		layout,
		model,
		{ where, limit: 1 },
		mapField,
	);
	return documents[0] ?? null;
}

/**
 * Better Auth types results by the caller's model, which only exists in its
 * runtime schema. This is the single place stored JSON crosses into that
 * generic, so the conversion is isolated here rather than repeated.
 */
function asResult<T>(document: AuthDocument): T {
	return document as T;
}

/**
 * Shape of the declared schema this adapter needs, written structurally so it satisfies both the
 * 1.6 and 1.7 type definitions -- `indexes` is optional, and 1.6 simply never declares any.
 */
type DeclaredSchema = Record<
	string,
	{
		readonly fields: Record<string, {
			readonly unique?: boolean | undefined;
			readonly required?: boolean | undefined;
		}>;
		readonly indexes?: readonly { readonly fields: readonly string[]; readonly unique?: boolean | undefined }[] | undefined;
	}
>;

/**
 * A Cosmos unique key is scoped to a logical partition, so a constraint Better Auth declares
 * globally holds only where the partition key is derived from exactly the constrained fields.
 * `accountPartition: "accountKey"` does that for `(providerId, accountId)`; nothing else does, so
 * `user.email` and the rest fall back to Better Auth's own existence checks.
 *
 * Silence would read as protection, but so would a false alarm read as noise: naming a
 * constraint the database does enforce teaches operators to ignore the warning and to add
 * redundant application-level enforcement. Only what the active layout leaves unenforced is
 * named, and only model and field names are printed, never values.
 */
function warnUnenforceableUniqueness(schema: DeclaredSchema, layout: CosmosLayout): void {
	const unenforceable: string[] = [];

	for (const [model, table] of Object.entries(schema)) {
		for (const [field, definition] of Object.entries(table.fields)) {
			if (definition.unique === true && !layout.enforcesUnique(model, [field])) {
				unenforceable.push(`${model}.${field}`);
			}
		}
		for (const index of table.indexes ?? []) {
			if (index.unique === true && !layout.enforcesUnique(model, index.fields)) {
				unenforceable.push(`${model}(${index.fields.join(", ")})`);
			}
		}
	}

	if (unenforceable.length === 0) {
		return;
	}

	console.warn(
		`[better-auth-azure-cosmos] Cosmos unique keys are scoped to a logical partition, so these declared unique constraints are NOT enforced by the database: ${unenforceable.join("; ")}. ` +
			"Enforce them in the application, or create the container partitioned by a hash of exactly those fields with a matching uniqueKeyPolicy. " +
			"A partition key and a unique key policy are both immutable after a container is created.",
	);
}

function assertPartitionStrategiesSupported(
	layout: CosmosLayoutOptions | undefined,
	schema: DeclaredSchema,
	getModelName: (model: string) => string,
	getFieldName: (reference: { model: string; field: string }) => string,
): void {
	if (layout?.kind !== "container-per-model") {
		return;
	}
	if (layout.accountPartition === "accountKey" && schema[ACCOUNT_MODEL]?.fields["issuer"]?.required) {
		throw new Error(
			'accountPartition: "accountKey" cannot enforce an issuer-based account schema. Use Better Auth 1.6.x or 1.7.3+ without a required legacy issuer field, or use accountPartition: "id" without database-enforced identity uniqueness.',
		);
	}
	const strategies = [
		{ enabled: layout.accountPartition === "accountKey", model: ACCOUNT_MODEL, fields: ACCOUNT_KEY_FIELDS },
		{ enabled: layout.sessionPartition === "tokenHash", model: SESSION_MODEL, fields: [SESSION_TOKEN_FIELD] },
		{ enabled: layout.rateLimitPartition === "key", model: RATE_LIMIT_MODEL, fields: [RATE_LIMIT_KEY_FIELD] },
	];
	for (const { enabled, model, fields } of strategies) {
		if (!enabled || !schema[model]) {
			continue;
		}
		if (getModelName(model) !== model) {
			throw new Error(
				`The hashed ${model} partition strategy requires its default modelName. Remove the ${model}.modelName mapping and use layout.containerName to rename the physical container, or use the id partition strategy.`,
			);
		}
		const renamed = fields.filter((field) => getFieldName({ model, field }) !== field);
		if (renamed.length > 0) {
			throw new Error(
				`The hashed ${model} partition strategy requires the default stored field names: ${renamed.join(", ")}. Remove these field mappings or use the id partition strategy.`,
			);
		}
	}
}

export function cosmosAdapter(
	database: Database,
	config: CosmosAdapterConfig = {},
): AdapterFactory<BetterAuthOptions> {
	const layout = resolveLayout(database, config.layout);

	return createAdapterFactory({
		config: {
			adapterId: "azure-cosmos",
			adapterName: "Azure Cosmos DB for NoSQL",
			...(config.debugLogs ? { debugLogs: config.debugLogs } : {}),
			supportsJSON: true,
			// Cosmos stores JSON, which has no date type, so the factory serializes for us.
			supportsDates: false,
			supportsBooleans: true,
			supportsNumericIds: false,
			supportsUUIDs: false,
			// A Cosmos transaction is limited to a single logical partition, and every
			// document here has its own. consumeOne covers the case needing atomicity.
			transaction: false,
		},
		adapter: ({ getFieldName, getModelName, getDefaultModelName, schema }) => {
			assertPartitionStrategiesSupported(config.layout, schema, getModelName, getFieldName);
			warnUnenforceableUniqueness(schema, layout);

			const mapperFor =
				(model: string): FieldMapper =>
				(field) =>
					getFieldName({ model, field });

			/** A unique foreign field means the relation resolves to a single row. */
			const isUniqueJoinField = (joinModel: string, field: string): boolean =>
				schema[getDefaultModelName(joinModel)]?.fields[field]?.unique === true;

			async function applyJoins(
				model: string,
				document: AuthDocument,
				join: JoinConfig,
			): Promise<AuthDocument> {
				const joined: AuthDocument = { ...document };

				for (const [joinModel, joinConfig] of Object.entries(join)) {
					const sourceValue =
						document[getFieldName({ model, field: joinConfig.on.from })];
					if (
						typeof sourceValue !== "string" &&
						typeof sourceValue !== "number"
					) {
						continue;
					}

					const unique = isUniqueJoinField(joinModel, joinConfig.on.to);
					// An absent limit means unbounded, matching the first-party adapters.
					const bounded = !unique && typeof joinConfig.limit === "number";
					const related = await queryDocuments(
						layout,
						joinModel,
						{
							where: [
								{
									field: joinConfig.on.to,
									value: sourceValue,
									operator: "eq",
									connector: "AND",
									mode: "sensitive",
								},
							],
							...(unique ? { limit: 1 } : {}),
							...(bounded ? { limit: joinConfig.limit } : {}),
						},
						mapperFor(joinModel),
					);

					const records = related.map((record) =>
						toAuthDocument(record, layout.reservedFields),
					);
					joined[joinModel] = unique ? (records[0] ?? null) : records;
				}

				return joined;
			}

			return {
			async create({ model, data }) {
				const id: unknown = Reflect.get(data, "id");
				if (typeof id !== "string") {
					throw new Error(
						`The Cosmos adapter requires a string id for model "${model}".`,
					);
				}
				await layout
					.container(model)
					.items.create({ ...data, ...layout.stamp(model, data) });
				return data;
			},

			async findOne({ model, where, select, join }) {
				const mapField = mapperFor(model);
				const mappedSelect = select?.map(mapField);
				const stored = await readOne(layout, model, where, mapField);
				if (stored === null) {
					return null;
				}
				const document = toAuthDocument(stored, layout.reservedFields);
				if (!join) {
					return asResult(projectDocument(document, mappedSelect));
				}
				const joined = await applyJoins(model, document, join);
				return asResult(
					projectDocument(joined, mappedSelect, Object.keys(join)),
				);
			},

			async findMany({ model, where, limit, select, sortBy, offset, join }) {
				const mapField = mapperFor(model);
				const mappedSelect = select?.map(mapField);
				const documents = await queryDocuments(
					layout,
					model,
					{
						where: where ?? [],
						...(sortBy ? { sortBy } : {}),
						...(typeof offset === "number" ? { offset } : {}),
						// A join needs its source field, which a projection could drop.
						...(mappedSelect && !join ? { select: mappedSelect } : {}),
						limit,
					},
					mapField,
				);

				const records = documents.map((record) =>
					toAuthDocument(record, layout.reservedFields),
				);
				if (!join) {
					return records.map((record) =>
						asResult(projectDocument(record, mappedSelect)),
					);
				}

				const keep = Object.keys(join);
				const joined = await Promise.all(
					records.map((record) => applyJoins(model, record, join)),
				);
				return joined.map((record) =>
					asResult(projectDocument(record, mappedSelect, keep)),
				);
			},

			async count({ model, where }) {
				return countDocuments(layout, model, where ?? [], mapperFor(model));
			},

			async incrementOne({ model, where, increment, set }) {
				const mapField = mapperFor(model);
				for (let attempt = 0; attempt < MAX_INCREMENT_ATTEMPTS; attempt += 1) {
					const stored = await readOne(layout, model, where, mapField);
					if (stored === null) {
						return null;
					}

					const operations: PatchOperation[] = [];
					const next: StoredAuthDocument = { ...stored };
					for (const [field, value] of Object.entries(increment)) {
						const path = patchPath(mapField(field));
						const current = stored[path.slice(1)];
						next[path.slice(1)] = (typeof current === "number" ? current : 0) + value;
						operations.push(
							typeof current === "number"
								? { op: "incr", path, value }
								: { op: "set", path, value },
						);
					}
					for (const [field, value] of Object.entries(set ?? {})) {
						const storedField = mapField(field);
						next[storedField] = value as AuthFieldValue;
						operations.push({
							op: "set",
							path: patchPath(storedField),
							value: value as AuthFieldValue,
						});
					}
					if (operations.length === 0) {
						return asResult(toAuthDocument(stored, layout.reservedFields));
					}

					assertPartitionUnchanged(layout, model, stored, { ...next, ...layout.stamp(model, next) });
					const needsSnapshot =
						pointReadId(where) === null || operations.some((operation) => operation.op === "set");
					try {
						const item = layout
							.container(model)
							.item(stored.id, layout.partitionKeyOf(model, stored));
						const snapshotOptions = {
							accessCondition: { type: "IfMatch", condition: stored._etag },
						};
						const response = operations.length > 10
							? await item.replace<StoredAuthDocument>(next, snapshotOptions)
							: await item.patch<StoredAuthDocument>(
								{ operations },
								needsSnapshot ? snapshotOptions : undefined,
							);
						return response.resource
							? asResult(toAuthDocument(response.resource, layout.reservedFields))
							: null;
					} catch (error) {
						if (isStatus(error, PRECONDITION_FAILED)) {
							continue;
						}
						if (isStatus(error, NOT_FOUND)) {
							return null;
						}
						throw error;
					}
				}
				throw new Error(`Could not increment ${model} after repeated concurrent changes. Retry the operation.`);
			},


			async update({ model, where, update }) {
				const stored = await readOne(layout, model, where, mapperFor(model));
				if (stored === null) {
					return null;
				}
				const merged = { ...stored, ...update };
				const next = { ...merged, ...layout.stamp(model, merged) };
				assertPartitionUnchanged(layout, model, stored, next);
				const response = await layout
					.container(model)
					.item(stored.id, layout.partitionKeyOf(model, stored))
					.replace<StoredAuthDocument>(next, {
						accessCondition: { type: "IfMatch", condition: stored._etag },
					});
				if (!response.resource) {
					return null;
				}
				return asResult(toAuthDocument(response.resource, layout.reservedFields));
			},

			async updateMany({ model, where, update }) {
				const documents = await queryDocuments(
					layout,
					model,
					{ where },
					mapperFor(model),
				);
				let updated = 0;
				for (const stored of documents) {
					const merged = { ...stored, ...update };
					const next = { ...merged, ...layout.stamp(model, merged) };
					assertPartitionUnchanged(layout, model, stored, next);
					try {
						await layout
							.container(model)
							.item(stored.id, layout.partitionKeyOf(model, stored))
							.replace(next, {
								accessCondition: { type: "IfMatch", condition: stored._etag },
							});
						updated += 1;
					} catch (error) {
						if (!isStatus(error, PRECONDITION_FAILED)) {
							throw error;
						}
					}
				}
				return updated;
			},

			async delete({ model, where }) {
				const stored = await readOne(layout, model, where, mapperFor(model));
				if (stored === null) {
					return;
				}
				try {
					await layout
						.container(model)
						.item(stored.id, layout.partitionKeyOf(model, stored))
						.delete();
				} catch (error) {
					if (!isStatus(error, NOT_FOUND)) {
						throw error;
					}
				}
			},

			async deleteMany({ model, where }) {
				const documents = await queryDocuments(
					layout,
					model,
					{ where },
					mapperFor(model),
				);
				let deleted = 0;
				for (const stored of documents) {
					try {
						await layout
							.container(model)
							.item(stored.id, layout.partitionKeyOf(model, stored))
							.delete();
						deleted += 1;
					} catch (error) {
						if (!isStatus(error, NOT_FOUND)) {
							throw error;
						}
					}
				}
				return deleted;
			},

			/**
			 * The ETag precondition is what makes this single-use: two callers read
			 * the same document, but only the first delete matches the revision.
			 */
			async consumeOne({ model, where }) {
				const stored = await readOne(layout, model, where, mapperFor(model));
				if (stored === null) {
					return null;
				}
				try {
					await layout
						.container(model)
						.item(stored.id, layout.partitionKeyOf(model, stored))
						.delete({
							accessCondition: { type: "IfMatch", condition: stored._etag },
						});
				} catch (error) {
					if (isStatus(error, PRECONDITION_FAILED) || isStatus(error, NOT_FOUND)) {
						return null;
					}
					throw error;
				}
				return asResult(toAuthDocument(stored, layout.reservedFields));
			},
			};
		},
	});
}
