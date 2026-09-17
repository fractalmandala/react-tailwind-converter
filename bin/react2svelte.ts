#!/usr/bin/env node
// react2svelte — convert React (TSX/JSX) components to Svelte 5, on the Babel
// AST (hooks → runes, JSX → template). Run against files or folders.
//
//   pnpm react2svelte <paths...> [options]
//
// Options:
//   --write        write <file>.svelte beside each source (or into --out)
//   --out <dir>    output directory (flat, by basename); implies --write
//   --ext <.svelte>  output extension (default .svelte)
//   -              read stdin
//   -h, --help
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, dirname } from 'node:path';
import { convertReactToSvelte } from '../src/react/convert';

const SRC_EXT = new Set(['.jsx', '.tsx']);
const SKIP_DIR = new Set(['node_modules', '.git', '.svelte-kit', 'build', 'dist', 'target']);

interface Opts {
	paths: string[];
	write: boolean;
	out: string | null;
	ext: string;
	stdin: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): Opts {
	const o: Opts = { paths: [], write: false, out: null, ext: '.svelte', stdin: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--help' || a === '-h') o.help = true;
		else if (a === '--write') o.write = true;
		else if (a === '--out') { o.out = argv[++i]; o.write = true; }
		else if (a === '--ext') o.ext = argv[++i];
		else if (a === '-') o.stdin = true;
		else if (a.startsWith('-')) { console.error(`unknown option: ${a}`); process.exit(2); }
		else o.paths.push(a);
	}
	if (!o.ext.startsWith('.')) o.ext = '.' + o.ext;
	return o;
}

function collectFiles(input: string, acc: string[]): void {
	const st = statSync(input);
	if (st.isDirectory()) {
		for (const entry of readdirSync(input)) {
			if (SKIP_DIR.has(entry)) continue;
			collectFiles(join(input, entry), acc);
		}
	} else if (st.isFile() && SRC_EXT.has(extname(input).toLowerCase())) {
		acc.push(input);
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

function rel(p: string): string {
	const cwd = process.cwd();
	return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || (opts.paths.length === 0 && !opts.stdin)) {
		console.log(`react2svelte — React (TSX/JSX) → Svelte 5 (Babel AST)

  pnpm react2svelte <paths...> [options]

  --write        write <file>.svelte beside each source
  --out <dir>    write into <dir> (flat, by basename); implies --write
  --ext <.svelte>  output extension (default .svelte)
  -              read stdin
  -h, --help

Examples:
  pnpm react2svelte src/components --write
  pnpm react2svelte Todo.tsx > Todo.svelte
  cat Widget.tsx | pnpm react2svelte -`);
		process.exit(opts.help ? 0 : 2);
	}

	const jobs: Array<{ file: string; code: string }> = [];
	if (opts.stdin) jobs.push({ file: '<stdin>', code: await readStdin() });
	const files: string[] = [];
	for (const p of opts.paths) collectFiles(resolve(p), files);
	for (const f of files) jobs.push({ file: f, code: readFileSync(f, 'utf8') });

	if (jobs.length === 0) {
		console.error('react2svelte: no .tsx/.jsx files found.');
		process.exit(1);
	}

	let wrote = 0;
	const stdoutParts: string[] = [];
	for (const job of jobs) {
		let result;
		try {
			result = convertReactToSvelte(job.code);
		} catch (err) {
			console.error(`  ERROR ${rel(job.file)}: ${err instanceof Error ? err.message : err}`);
			continue;
		}
		const banner = result.warnings.length ? `  (${result.warnings.length} warning: ${result.warnings.join('; ')})` : '';
		if (opts.write && job.file !== '<stdin>') {
			const outPath = opts.out
				? join(opts.out, basename(job.file).replace(/\.[^.]+$/, '') + opts.ext)
				: job.file.replace(/\.[^.]+$/, '') + opts.ext;
			mkdirSync(dirname(outPath), { recursive: true });
			writeFileSync(outPath, result.svelte, 'utf8');
			console.error(`  wrote ${rel(outPath)}${banner}`);
			wrote++;
		} else {
			stdoutParts.push(result.svelte);
			if (banner) console.error(`${rel(job.file)}${banner}`);
		}
	}
	if (stdoutParts.length) process.stdout.write(stdoutParts.join('\n\n'));
	if (opts.write) console.error(`\nreact2svelte: wrote ${wrote} file(s).`);
}

main().catch((err) => {
	console.error('react2svelte error:', err instanceof Error ? err.message : err);
	process.exit(1);
});
