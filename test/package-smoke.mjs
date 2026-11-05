import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

test("the public ESM and CommonJS entrypoints load the same exports", async () => {
	const esm = await import("better-auth-azure-cosmos");
	const cjs = createRequire(import.meta.url)("better-auth-azure-cosmos");

	assert.equal(typeof esm.cosmosAdapter, "function");
	assert.equal(typeof esm.ensureAuthContainers, "function");
	assert.deepEqual(Object.keys(esm).sort(), Object.keys(cjs).sort());
});

test("all declared entrypoints exist in the build output", async () => {
	const manifestUrl = new URL("../package.json", import.meta.url);
	const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
	const entrypoints = manifest.exports["."];
	const targets = [
		manifest.main,
		manifest.module,
		manifest.types,
		...Object.values(entrypoints.import),
		...Object.values(entrypoints.require),
	];

	await Promise.all(targets.map((target) => access(new URL(target, manifestUrl))));
});
