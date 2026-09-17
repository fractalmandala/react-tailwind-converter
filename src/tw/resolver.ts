// Node-side class resolver: runs the real Tailwind v4 compiler over an explicit
// candidate list using the default theme + utilities shipped with the installed
// `tailwindcss`. Pure JS, filesystem-backed — the CLI uses this (no browser,
// no Vite, no Oxide content scanning).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compile } from 'tailwindcss';

const require = createRequire(import.meta.url);
const twDir = require.resolve('tailwindcss/package.json').replace(/package\.json$/, '');

const FILES: Record<string, string> = {
	'tailwindcss/theme.css': 'theme.css',
	'tailwindcss/theme': 'theme.css',
	'tailwindcss/utilities.css': 'utilities.css',
	'tailwindcss/utilities': 'utilities.css'
};

const cache = new Map<string, string>();
function read(rel: string): string {
	if (!cache.has(rel)) cache.set(rel, readFileSync(twDir + rel, 'utf8'));
	return cache.get(rel)!;
}

const SOURCE = '@import "tailwindcss/theme.css";@import "tailwindcss/utilities.css";';

export async function resolveClassesToCss(classes: string[]): Promise<string> {
	if (classes.length === 0) return '';
	const loadStylesheet = async (id: string) => {
		const file = FILES[id];
		if (file) return { path: twDir + file, base: twDir, content: read(file) };
		throw new Error(`tw2sass: cannot resolve stylesheet "${id}"`);
	};
	const loadModule = async () => {
		throw new Error('tw2sass: @plugin/@config JS modules are not supported');
	};
	const compiler = await compile(SOURCE, { base: twDir, loadStylesheet, loadModule });
	return compiler.build(classes);
}
