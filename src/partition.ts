import { createHash } from "node:crypto";

import type { AuthDocument } from "./document";

/**
 * Better Auth resolves the session credential by `token` on the highest-frequency read path, so a
 * session container partitioned by `/id` forces that lookup to run without a partition key. This
 * module derives a partition key from the token instead.
 *
 * The raw token is a bearer credential and never becomes partition-key material: only its SHA-256
 * digest is stored and routed on.
 */
export const SESSION_MODEL = "session";
export const SESSION_TOKEN_FIELD = "token";
export const SESSION_TOKEN_HASH_FIELD = "tokenHash";

export type SessionPartitionStrategy = "id" | "tokenHash";

/** Lowercase hexadecimal, one stable encoding everywhere a token hash is produced or compared. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Reads the hash a stored session routes on, deriving it from the token when the field is absent so
 * a document written before the field existed still resolves.
 */
export function sessionTokenHashOf(document: AuthDocument): string | null {
  const stored = document[SESSION_TOKEN_HASH_FIELD];
  if (typeof stored === "string" && stored.length > 0) {
    return stored;
  }
  const token = document[SESSION_TOKEN_FIELD];
  return typeof token === "string" ? hashSessionToken(token) : null;
}

/**
 * The hash a session should carry. The token is the source of truth, so a stored hash is trusted
 * only when the document does not carry the token it was derived from.
 */
export function deriveSessionTokenHash(document: AuthDocument): string | null {
  const token = document[SESSION_TOKEN_FIELD];
  if (typeof token === "string") {
    return hashSessionToken(token);
  }
  const stored = document[SESSION_TOKEN_HASH_FIELD];
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

/**
 * Better Auth 1.7 resolves an account with `findAccountOwnerByKey({ issuer, accountId })` and
 * declares that pair unique. A Cosmos unique key is only enforced within a logical partition, so
 * partitioning on a hash of exactly those two fields puts every colliding row in one partition and
 * lets the database enforce the constraint the schema declares.
 */
export const ACCOUNT_MODEL = "account";
export const ACCOUNT_ISSUER_FIELD = "issuer";
export const ACCOUNT_ID_FIELD = "accountId";
export const ACCOUNT_KEY_HASH_FIELD = "accountKeyHash";

export type AccountPartitionStrategy = "id" | "accountKey";

/** Lowercase hexadecimal, matching `hashSessionToken`. Both halves stay verbatim. */
export function hashAccountKey(issuer: string, accountId: string): string {
	return createHash("sha256").update(`${issuer}\u0000${accountId}`, "utf8").digest("hex");
}

export function accountKeyHashOf(document: AuthDocument): string | null {
	const stored = document[ACCOUNT_KEY_HASH_FIELD];
	if (typeof stored === "string" && stored.length > 0) {
		return stored;
	}
	const issuer = document[ACCOUNT_ISSUER_FIELD];
	const accountId = document[ACCOUNT_ID_FIELD];
	return typeof issuer === "string" && typeof accountId === "string"
		? hashAccountKey(issuer, accountId)
		: null;
}
