import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Cosmos round trips are slower than an in-process database.
		testTimeout: 60_000,
		hookTimeout: 180_000,
		fileParallelism: false,
	},
});
