import type { Container, Database, SqlParameter } from "@azure/cosmos";
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
	type StoredAuthDocument,
} from "./document";
import { resolveLayout, type CosmosLayout, type CosmosLayoutOptions } from "./layout";
import {
	buildWherePredicate,
	createParameterCollector,
	quoteFieldPath,
	type FieldMapper,
} from "./where";

const NOT_FOUND = 404;
const PRECONDITION_FAILED = 412;

export type CosmosAdapterConfig = {
	readonly layout?: CosmosLayoutOptions;
	readonly debugLogs?: DBAdapterDebugLogOption;
};

type QueryShape = {
	readonly where: readonly CleanedWhere[];
	readonly sortBy?: { readonly field: string; readonly direction: "asc" | "desc" };
	readonly limit?: number;
	readonly offset?: number;
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
	query +=
		shape.select && shape.select.length > 0
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
	const container: Container = layout.container(model);
	const spec = buildQuery(layout, model, shape, mapField);
	const response = await container.items
		.query<StoredAuthDocument>(spec)
		.fetchAll();
	return response.resources;
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
	const id = pointReadId(where);
	if (id !== null) {
		try {
			const response = await layout
				.container(model)
				.item(id, layout.partitionKey(model, id))
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
		adapter: ({ getFieldName, getDefaultModelName, schema }) => {
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
					.items.create({ ...data, ...layout.stamp(model) });
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
				const documents = await queryDocuments(
					layout,
					model,
					{ where: where ?? [] },
					mapperFor(model),
				);
				return documents.length;
			},

			async update({ model, where, update }) {
				const stored = await readOne(layout, model, where, mapperFor(model));
				if (stored === null) {
					return null;
				}
				const next = { ...stored, ...update, ...layout.stamp(model) };
				const response = await layout
					.container(model)
					.item(stored.id, layout.partitionKey(model, stored.id))
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
					const next = { ...stored, ...update, ...layout.stamp(model) };
					try {
						await layout
							.container(model)
							.item(stored.id, layout.partitionKey(model, stored.id))
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
						.item(stored.id, layout.partitionKey(model, stored.id))
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
							.item(stored.id, layout.partitionKey(model, stored.id))
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
						.item(stored.id, layout.partitionKey(model, stored.id))
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
