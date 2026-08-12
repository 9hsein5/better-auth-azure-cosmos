import type { CleanedWhere } from "better-auth/adapters";

export type SqlParameterValue =
	| string
	| number
	| boolean
	| null
	| string[]
	| number[];

export type SqlParameterBinding = {
	readonly name: string;
	readonly value: SqlParameterValue;
};

export type SqlPredicate = {
	readonly text: string;
	readonly parameters: readonly SqlParameterBinding[];
};

/**
 * Field names come from the Better Auth schema rather than request input, but
 * they are interpolated into SQL text, so they are validated instead of trusted.
 */
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteFieldPath(field: string): string {
	if (!FIELD_NAME_PATTERN.test(field)) {
		throw new Error(`Unsupported Cosmos field name: ${field}`);
	}
	return `c["${field}"]`;
}

export type ParameterCollector = {
	bind(value: CleanedWhere["value"]): string;
	readonly bindings: SqlParameterBinding[];
};

export function createParameterCollector(prefix: string): ParameterCollector {
	const bindings: SqlParameterBinding[] = [];
	return {
		bindings,
		bind(value) {
			const name = `@${prefix}${bindings.length}`;
			bindings.push({ name, value: serializeValue(value) });
			return name;
		},
	};
}

function serializeValue(value: CleanedWhere["value"]): SqlParameterValue {
	if (value instanceof Date) {
		return value.toISOString();
	}
	return value;
}

function isInsensitiveStringClause(clause: CleanedWhere): boolean {
	return clause.mode === "insensitive" && typeof clause.value === "string";
}

function clauseToSql(
	clause: CleanedWhere,
	collector: ParameterCollector,
): string {
	const path = quoteFieldPath(clause.field);
	const insensitive = isInsensitiveStringClause(clause);
	const caseArgument = insensitive ? ", true" : "";
	const operator = clause.operator ?? "eq";

	switch (operator) {
		case "eq":
			return insensitive
				? `STRINGEQUALS(${path}, ${collector.bind(clause.value)}, true)`
				: `${path} = ${collector.bind(clause.value)}`;
		case "ne":
			return insensitive
				? `NOT STRINGEQUALS(${path}, ${collector.bind(clause.value)}, true)`
				: `${path} != ${collector.bind(clause.value)}`;
		case "lt":
			return `${path} < ${collector.bind(clause.value)}`;
		case "lte":
			return `${path} <= ${collector.bind(clause.value)}`;
		case "gt":
			return `${path} > ${collector.bind(clause.value)}`;
		case "gte":
			return `${path} >= ${collector.bind(clause.value)}`;
		case "in":
			return `ARRAY_CONTAINS(${collector.bind(clause.value)}, ${path})`;
		case "not_in":
			return `NOT ARRAY_CONTAINS(${collector.bind(clause.value)}, ${path})`;
		case "contains":
			return `CONTAINS(${path}, ${collector.bind(clause.value)}${caseArgument})`;
		case "starts_with":
			return `STARTSWITH(${path}, ${collector.bind(clause.value)}${caseArgument})`;
		case "ends_with":
			return `ENDSWITH(${path}, ${collector.bind(clause.value)}${caseArgument})`;
		default: {
			const exhaustive: never = operator;
			throw new Error(
				`Unsupported Cosmos where operator: ${String(exhaustive)}`,
			);
		}
	}
}

/**
 * Mirrors the grouping the first-party adapters use: every AND clause must
 * hold, and at least one OR clause must hold.
 */
export function buildWherePredicate(
	where: readonly CleanedWhere[],
	collector: ParameterCollector,
): string {
	const conjunctions: string[] = [];
	const disjunctions: string[] = [];

	for (const clause of where) {
		const text = clauseToSql(clause, collector);
		if (clause.connector === "OR") {
			disjunctions.push(text);
		} else {
			conjunctions.push(text);
		}
	}

	const groups: string[] = [];
	if (conjunctions.length > 0) {
		groups.push(`(${conjunctions.join(" AND ")})`);
	}
	if (disjunctions.length > 0) {
		groups.push(`(${disjunctions.join(" OR ")})`);
	}

	return groups.join(" AND ");
}
