# better-auth-azure-cosmos

[![npm version](https://img.shields.io/npm/v/better-auth-azure-cosmos.svg)](https://www.npmjs.com/package/better-auth-azure-cosmos)
[![Better Auth community adapter](https://img.shields.io/badge/Better_Auth-community_adapter-000000)](https://better-auth.com/docs/adapters/community-adapters)

An [Azure Cosmos DB for NoSQL](https://learn.microsoft.com/azure/cosmos-db/nosql/) adapter for [Better Auth](https://better-auth.com).

Cosmos DB for NoSQL is not one of Better Auth's built-in adapters. This package implements the
[custom adapter contract](https://better-auth.com/docs/guides/create-a-db-adapter) on top of the
`@azure/cosmos` SDK, including a native `consumeOne` so single-use tokens are genuinely atomic.

## Install

```bash
npm install better-auth-azure-cosmos @azure/cosmos
```

`better-auth` (>= 1.6.0) and `@azure/cosmos` (^4) are peer dependencies.

## Quick start

```ts
import { CosmosClient } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import { betterAuth } from "better-auth";
import { cosmosAdapter } from "better-auth-azure-cosmos";

const client = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  aadCredentials: new DefaultAzureCredential(),
});

export const auth = betterAuth({
  database: cosmosAdapter(client.database("auth")),
});
```

## Create the containers first

A partition key **cannot be changed after a container is created**. Use the bundled helper once,
against a new database, rather than creating containers by hand:

```ts
import { ensureAuthContainers } from "better-auth-azure-cosmos";

await ensureAuthContainers(client.database("auth"));
```

## Layouts

### `single-container` (default)

Every model shares one container, partitioned on `[/docModel, /id]` (a hierarchical key). Cheapest
option, and the right one when throughput is shared at the database level.

```ts
cosmosAdapter(database, {
  layout: { kind: "single-container", containerName: "auth", modelField: "docModel" },
});
```

`modelField` must not collide with a field name used by any model or plugin you enable.

### `container-per-model`

One container per model, partitioned on `/id`. Mirrors the table layout of the SQL adapters and
isolates throughput per model.

```ts
cosmosAdapter(database, {
  layout: { kind: "container-per-model" },
});

await ensureAuthContainers(database, {
  layout: { kind: "container-per-model" },
  models: ["user", "session", "account", "verification"],
});
```

Every model needs its own container, so `models` has to list every model your configuration
touches — including the ones plugins add (`organization`, `member`, `invitation`, `team`, and so
on) and any physical name you remap with `modelName`. A model whose container is missing fails its
first read with a Cosmos 404 (`Owner resource does not exist`) rather than returning no rows.
`single-container` needs none of this, because every model shares one container.

#### Sessions on `/tokenHash`

Better Auth resolves a session by its `token` on every authenticated request. Partitioned on `/id`,
that lookup cannot be scoped to a partition, so the hottest read in the system fans out across all
of them. Partition the session container on a stored SHA-256 of the token instead:

```ts
const layout = {
  kind: "container-per-model",
  sessionPartition: "tokenHash",
} as const;

cosmosAdapter(database, { layout });
await ensureAuthContainers(database, { layout, models: ["user", "session", "account", "verification"] });
```

The trade is deliberate — token-addressed reads get cheap, user-addressed ones stay unscoped:

| Operation | `id` (default) | `tokenHash` |
| --- | --- | --- |
| Resolve a session by token | Cross-partition | Single partition |
| Update or delete by token | Cross-partition | Single partition |
| List or revoke a user's sessions | Cross-partition | Cross-partition |
| Read a session by `id` | Point read | Cross-partition |

Only the digest is stored and routed on: the raw token is a bearer credential and never becomes
partition-key material. `tokenHash` is storage-only and never reaches Better Auth.

A token is immutable under this strategy. Changing one would move the document to another
partition, which Cosmos cannot do in place, so such an update is refused rather than written back
where its new token would no longer find it.

Because a partition key cannot be changed after a container is created, this must be chosen up
front. An existing deployment needs a new session container rather than an in-place change —
sessions are short-lived, so letting the old ones expire is usually migration enough.

## Behaviour and limitations

| Capability | Status |
| --- | --- |
| `consumeOne` | Native, via an ETag (`If-Match`) conditional delete |
| Joins | Supported, resolved as follow-up queries |
| Case-insensitive matching | Supported, via `STRINGEQUALS` / `CONTAINS` / `STARTSWITH` / `ENDSWITH` |
| Dates | Stored as ISO strings — Cosmos JSON has no date type |
| Numeric ids | Not supported; ids are strings |
| Transactions | Not supported |

**Transactions.** A Cosmos transactional batch is limited to a single logical partition, and every
document here lives in its own. The adapter therefore reports `transaction: false` and Better Auth
runs those operations sequentially. `consumeOne` is implemented natively so that single-use
credentials such as magic links and OTPs stay race-safe without a transaction.

**Uniqueness.** Cosmos unique key policies are enforced *within a logical partition*, so they cannot
enforce uniqueness across documents under either layout. Better Auth's own existence checks apply,
but the database will not be the final arbiter of, for example, a duplicate email under a race.

**Query cost.** Only a lookup by `id` is a point read. Every other `where` becomes a query. Under
the `single-container` layout those queries are scoped by the model prefix of the partition key,
and sessions can be scoped further — see [Sessions on `/tokenHash`](#sessions-on-tokenhash).

## Testing

The suite runs against the Cosmos DB emulator:

```bash
npm run emulator:up
npm test
npm run emulator:down
```

Point it at a real account instead with `COSMOS_ENDPOINT`, `COSMOS_KEY` and `COSMOS_DATABASE`.

It runs Better Auth's own `normal`, `authFlow`, `caseInsensitive` and `joins` conformance suites,
once per layout, plus routing tests that assert which queries reach a single partition. The
`numberId` and `transactions` suites are intentionally not run — see the table above.

## License

MIT
