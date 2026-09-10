# better-auth-azure-cosmos

[![npm version](https://img.shields.io/npm/v/better-auth-azure-cosmos.svg)](https://www.npmjs.com/package/better-auth-azure-cosmos)  
[![npm downloads](https://img.shields.io/npm/dt/better-auth-azure-cosmos)](https://www.npmjs.com/package/better-auth-azure-cosmos)  
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

**Account identity (`accountPartition`).** Better Auth resolves an account with
`findAccountOwnerByKey({ providerId, accountId })`. Set `accountPartition: "accountKey"` on the
`container-per-model` layout to let the database enforce that pair: the `account` container is
partitioned on `/accountKeyHash` (a stored `sha256(providerId NUL accountId)`) and created with a
unique key policy on `["/providerId", "/accountId"]`. Because the partition key is derived from
exactly those paths, every colliding row lands in one logical partition -- the only scope a Cosmos
unique key has -- so the database rejects a duplicate with a 409. Better Auth 1.7.3+ does not declare
that pair unique in its core schema; declare it yourself through a plugin `schema` (`account.indexes`)
if you want the startup warning to track it, and this layout is what makes the declaration true.

The trade is the same one `sessionPartition` makes: resolving an account by provider becomes
partition-scoped, while listing or deleting a user's accounts by `userId` becomes cross-partition.
It defaults to `"id"`, so existing deployments are unchanged. On Better Auth 1.7.0–1.7.2, which
resolve accounts by the since-removed `issuer` field, `accountKey` still constructs and returns
correct results, but those lookups fall back to cross-partition queries and the `(issuer, accountId)`
pair those versions rely on is not database-enforced; upgrade to 1.7.3+ for the intended behaviour.
`accountKey` requires `providerId` and `accountId` to keep their default stored field names; a
`fields` mapping that renames either is refused at construction.

Both a partition key and a unique key policy are **immutable after a container is created**, so this
is a decision to make before `ensureAuthContainers` first runs. `single-container` cannot enforce it
at all: that layout partitions on `[docModel, id]`, giving every row its own logical partition.

> **Upgrading from 0.4.x with `accountKey`.** Versions 0.4.0–0.4.3 hashed the Better Auth 1.7.0–1.7.2
> `issuer` field, which Better Auth removed again in 1.7.3 (see the
> [account-schema post](https://better-auth.com/blog/1-7-account-schema)). An `account` container
> created by 0.4.x therefore carries `accountKeyHash` values and a `["/issuer", "/accountId"]` unique
> key policy that this version does not produce. `ensureAuthContainers` refuses such a container, but
> the adapter itself does not inspect containers at runtime -- against an unconverted container every
> account lookup misses silently and sign-in creates duplicate users -- so run `ensureAuthContainers`
> before 0.5.0 serves traffic. Export the accounts, drop the container, let `ensureAuthContainers`
> recreate it, and re-import with the old `accountKeyHash` and `issuer` fields stripped so the new
> hash is stamped on write; there is no in-place migration because both the partition key and the
> unique key policy are immutable.

**Rate limiting.** Better Auth declares `rateLimit.key` unique and, when a create is rejected,
re-reads and increments the existing row instead. Under `/id` nothing rejects the duplicate, so a
concurrent first burst seeds one row per request and each gets its own budget -- measured as 12
concurrent requests admitting 11 against a limit of 3, across 10 rows. Set
`rateLimitPartition: "key"` to partition that container on `/keyHash` with `key` as its unique
key; the second concurrent seed is then rejected and Better Auth's own recovery path takes over.
The limit check itself lives in the caller's `where` (`count < max`), and `incrementOne` guards
the write with an `If-Match` ETag whenever a `set` is present, which is what serialises the
check-then-act. Removing that guard would let every racing caller win at once.

**`incrementOne` seeding.** Increments are applied with `incr` and no precondition, so concurrent
increments compose. A field that does not exist yet cannot be incremented, so it is seeded with
`set` from a read -- and that seeding write does not compose. Two concurrent first-increments both
seed, yielding `value` rather than twice it.

**Uniqueness.** Cosmos unique key policies are enforced *within a logical partition*, so a declared
constraint is enforced only where the partition key is derived from exactly the constrained fields.
`accountPartition: "accountKey"` does that for `(providerId, accountId)` and `rateLimitPartition: "key"`
for `rateLimit.key`; no other layout enforces any
declared constraint. Everything else -- `user.email`, `session.token` -- relies on Better Auth's own
existence checks, and the database will not be the final arbiter of, for example, a duplicate email
under a race. At construction the adapter warns, naming exactly the constraints the *active* layout
leaves unenforced.

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
