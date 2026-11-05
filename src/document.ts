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

const SYSTEM_FIELDS = new Set(["_rid", "_self", "_etag", "_attachments", "_ts", "_lsn"]);

/**
 * Removes Cosmos system properties and any field the layout added, so Better
 * Auth only ever sees fields that exist in its own schema.
 */
export function toAuthDocument(
	stored: StoredAuthDocument,
	reservedFields: readonly string[],
): AuthDocument {
	return Object.fromEntries(
		Object.entries(stored).filter(([key]) =>
			!SYSTEM_FIELDS.has(key) && !reservedFields.includes(key),
		),
	);
}
