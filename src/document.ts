/**
 * Cosmos stores JSON, so every value reaching the adapter has already been
 * reduced to a JSON primitive by Better Auth's input transform.
 */
export type AuthFieldValue =
	| string
	| number
	| boolean
	| null
	| AuthFieldValue[]
	| { [key: string]: AuthFieldValue };

export type AuthDocument = { [key: string]: AuthFieldValue };

export type StoredAuthDocument = AuthDocument & {
	id: string;
	_etag: string;
};

/**
 * Removes Cosmos system properties and any field the layout added, so Better
 * Auth only ever sees fields that exist in its own schema.
 */
export function toAuthDocument(
	stored: StoredAuthDocument,
	reservedFields: readonly string[],
): AuthDocument {
	const result: AuthDocument = {};
	for (const [key, value] of Object.entries(stored)) {
		if (key.startsWith("_") || reservedFields.includes(key)) {
			continue;
		}
		result[key] = value;
	}
	return result;
}
