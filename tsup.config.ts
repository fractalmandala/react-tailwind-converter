import { defineConfig } from 'tsup';

// Builds the two CLI entry points to dist/*.js. Runtime dependencies
// (tailwindcss, postcss, @babel/*, node-html-parser) are externalized — they
// are installed alongside the package — so dist stays small and each bin keeps
// its `#!/usr/bin/env node` shebang.
export default defineConfig({
	entry: ['bin/tw2sass.ts', 'bin/react2svelte.ts'],
	format: ['esm'],
	target: 'node18',
	platform: 'node',
	clean: true,
	splitting: false,
	sourcemap: false,
	dts: false,
	shims: false
});
