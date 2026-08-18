export { cosmosAdapter, type CosmosAdapterConfig } from "./adapter";
export {
	ensureAuthContainers,
	type EnsureContainersOptions,
} from "./bootstrap";
export {
	DEFAULT_CONTAINER_NAME,
	DEFAULT_MODEL_FIELD,
	type CosmosLayout,
	type CosmosLayoutOptions,
} from "./layout";
export type { AuthDocument, AuthFieldValue, StoredAuthDocument } from "./document";
export {
	ACCOUNT_KEY_HASH_FIELD,
	RATE_LIMIT_KEY_HASH_FIELD,
	SESSION_TOKEN_HASH_FIELD,
	hashAccountKey,
	hashRateLimitKey,
	hashSessionToken,
	type AccountPartitionStrategy,
	type RateLimitPartitionStrategy,
	type SessionPartitionStrategy,
} from "./partition";
