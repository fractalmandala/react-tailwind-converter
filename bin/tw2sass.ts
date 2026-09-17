#!/usr/bin/env node
// tw2sass — convert Tailwind utility classes to indented Sass, using the real
// Tailwind v4 compiler (no hand-authored map). Run against component files, a
// folder of them, or a CSS/text file of classes / @apply rules.
//
//   pnpm tw2sass <paths...> [options]
//
// Modes (auto-detected per file, override with --mode):
//   component  markup files (.svelte/.html/.jsx/.tsx/.vue/.astro) — reads every
//              class="…"/className="…", emits Sass nested to mirror the DOM.
//   apply      .css/.scss with @apply — expands each rule's utilities.
//   classes    a bag of class tokens — emits one block (--selector, or file stem).
//
// Options:
//   --write            write <file>.sass beside each source (or into --out)
//   --out <dir>        output directory (implies --write; flat, by basename)
//   --mode <m>         auto | component | apply | classes   (default auto)
//   --selector <name>  selector for classes mode (default: file stem)
//   --ext <.sass>      output extension (default .sass)
//   -                  read stdin (needs --mode; default component)
//   --help
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve, dirname } from 'node:path';
import { parseMarkup, collectClasses, staticClassTokens, type ElementNode } from '../src/tw/markup';
import { extractUtilities, type SassNode } from '../src/tw/engine';
import { renderTree } from '../src/tailwind';
import { collectApplyTokens, hasApply, expandApply } from '../src/tw/apply';
import { resolveClassesToCss } from '../src/tw/resolver';

const MARKUP_EXT = new Set(['.svelte', '.html', '.htm', '.jsx', '.tsx', '.vue', '.astro']);
const STYLE_EXT = new Set(['.css', '.scss', '.sass']);
const SKIP_DIR = new Set(['node_modules', '.git', '.svelte-kit', 'build', 'dist', 'target']);

type Mode = 'auto' | 'component' | 'apply' | 'classes';
interface Opts {
	paths: string[];
	write: boolean;
	out: string | null;
	mode: Mode;
	selector: string | null;
	ext: string;
	stdin: boolean;
	help: boolean;
}

function parseArgs(argv: string[]): Opts {
	const o: Opts = { paths: [], write: false, out: null, mode: 'auto', selector: null, ext: '.sass', stdin: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--help' || a === '-h') o.help = true;
		else if (a === '--write') o.write = true;
		else if (a === '--out') { o.out = argv[++i]; o.write = true; }
		else if (a === '--mode') o.mode = argv[++i] as Mode;
		else if (a === '--selector') o.selector = argv[++i];
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
	} else if (st.isFile()) {
		const ext = extname(input).toLowerCase();
		if (MARKUP_EXT.has(ext) || STYLE_EXT.has(ext) || ext === '.txt') acc.push(input);
	}
}

function modeFor(file: string, text: string, forced: Mode): Exclude<Mode, 'auto'> {
	if (forced !== 'auto') return forced;
	const ext = extname(file).toLowerCase();
	if (MARKUP_EXT.has(ext)) return 'component';
	if (STYLE_EXT.has(ext)) return hasApply(text) ? 'apply' : 'classes';
	return 'classes';
}

interface Job {
	file: string;
	mode: Exclude<Mode, 'auto'>;
	text: string;
	tree?: ElementNode[]; // component
	classes?: string[]; // classes
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help || (opts.paths.length === 0 && !opts.stdin)) {
		printHelp();
		process.exit(opts.help ? 0 : 2);
	}

	// 1. Gather jobs (one per input file / stdin) and every candidate class.
	const jobs: Job[] = [];
	const candidates = new Set<string>();

	const addJob = (file: string, text: string, forced: Mode) => {
		const mode = modeFor(file, text, forced);
		const job: Job = { file, mode, text };
		if (mode === 'component') {
			job.tree = parseMarkup(text);
			for (const c of collectClasses(job.tree)) candidates.add(c);
		} else if (mode === 'apply') {
			for (const c of collectApplyTokens(text)) candidates.add(c);
		} else {
			job.classes = staticClassTokens(text);
			for (const c of job.classes) candidates.add(c);
		}
		jobs.push(job);
	};

	if (opts.stdin) {
		const text = await readStdin();
		addJob('<stdin>', text, opts.mode === 'auto' ? 'component' : opts.mode);
	}
	const files: string[] = [];
	for (const p of opts.paths) collectFiles(resolve(p), files);
	for (const f of files) addJob(f, readFileSync(f, 'utf8'), opts.mode);

	if (jobs.length === 0) {
		console.error('tw2sass: no supported files found.');
		process.exit(1);
	}

	// 2. Resolve every class through Tailwind in ONE compile, then extract once.
	const css = await resolveClassesToCss([...candidates]);
	const { classMap, keyframes } = extractUtilities(css, candidates);

	// 3. Render each job.
	let wrote = 0;
	const stdoutParts: string[] = [];
	const allKeyframes: SassNode[] = [];
	const seenKeyframes = new Set<string>();
	for (const kf of keyframes) {
		const key = kf.kind === 'atrule' ? kf.params : '';
		if (!seenKeyframes.has(key)) { seenKeyframes.add(key); allKeyframes.push(kf); }
	}

	for (const job of jobs) {
		let sass = '';
		let unknown: string[] = [];
		if (job.mode === 'component') {
			const r = renderTree(job.tree!, classMap);
			sass = r.sass; unknown = r.unknownClasses;
		} else if (job.mode === 'apply') {
			sass = expandApply(job.text, classMap);
		} else {
			const selector = (opts.selector ?? stem(job.file)).replace(/^\./, '');
			const r = renderTree([{ tag: selector, classes: job.classes!, children: [] }], classMap);
			sass = r.sass; unknown = r.unknownClasses;
		}

		if (!sass) { console.error(`  (skipped, no classes) ${rel(job.file)}`); continue; }

		if (opts.write && job.file !== '<stdin>') {
			const outPath = opts.out
				? join(opts.out, stem(job.file) + opts.ext)
				: job.file.replace(/\.[^.]+$/, '') + opts.ext;
			mkdirSync(dirname(outPath), { recursive: true });
			writeFileSync(outPath, sass + '\n', 'utf8');
			console.error(`  wrote ${rel(outPath)}${unknown.length ? `  (${unknown.length} non-utility class kept as selector)` : ''}`);
			wrote++;
		} else {
			stdoutParts.push(`// ${rel(job.file)}\n${sass}`);
		}
	}

	// keyframes emitted once
	if (allKeyframes.length) {
		const { emitSass } = await import('../src/tw/engine');
		const kfSass = emitSass(allKeyframes).trim();
		if (opts.write && opts.out) {
			writeFileSync(join(opts.out, '_keyframes' + opts.ext), kfSass + '\n', 'utf8');
			console.error(`  wrote ${rel(join(opts.out, '_keyframes' + opts.ext))}`);
		} else if (!opts.write) {
			stdoutParts.push(`// @keyframes\n${kfSass}`);
		}
	}

	if (stdoutParts.length) process.stdout.write(stdoutParts.join('\n\n') + '\n');
	if (opts.write) console.error(`\ntw2sass: wrote ${wrote} file(s).`);
}

function stem(file: string): string {
	return basename(file).replace(/\.[^.]+$/, '') || 'generated';
}
function rel(p: string): string {
	const cwd = process.cwd();
	return p.startsWith(cwd) ? p.slice(cwd.length + 1) : p;
}

function printHelp() {
	console.log(`tw2sass — Tailwind classes → indented Sass (real Tailwind v4 engine)

  pnpm tw2sass <paths...> [options]

Inputs: files or folders. Auto-detected per file:
  .svelte/.html/.jsx/.tsx/.vue/.astro  component  (nested Sass mirroring the DOM)
  .css/.scss with @apply               apply      (expands @apply rules)
  .css/.scss/.txt (class tokens)       classes    (one block)

Options:
  --write            write <file>.sass beside each source
  --out <dir>        write into <dir> (flat, by basename); implies --write
  --mode <m>         auto | component | apply | classes   (default auto)
  --selector <name>  selector name for classes mode (default: file stem)
  --ext <.sass>      output extension (default .sass)
  -                  read stdin (with --mode, default component)
  -h, --help

Examples:
  pnpm tw2sass src/components --write
  pnpm tw2sass Button.tsx > button.sass
  pnpm tw2sass utilities.css --mode apply --write
  echo '<div class="px-4 flex hover:bg-black/50">' | pnpm tw2sass - --selector card`);
}

main().catch((err) => {
	console.error('tw2sass error:', err instanceof Error ? err.message : err);
	process.exit(1);
});
