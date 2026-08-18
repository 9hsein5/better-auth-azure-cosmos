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
	SESSION_TOKEN_HASH_FIELD,
	hashSessionToken,
	type SessionPartitionStrategy,
} from "./partition";
