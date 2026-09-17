// Tailwind → indented Sass, AST-based (Node/CLI).
//
// Pipeline: markup → element tree (node-html-parser) → collect classes →
// resolve them through the *real* Tailwind v4 compiler → PostCSS → nested Sass
// whose structure mirrors the DOM. There is no hand-authored utility map; every
// value is exactly what Tailwind emits (theme tokens inlined for raw output).
//
// The compiler step is injected so callers can batch-resolve across many files.
import { parseMarkup, collectClasses, type ElementNode } from './tw/markup';
import { extractUtilities, emitSass, type UtilityRule, type SassNode } from './tw/engine';
import { buildSassTree } from './tw/build';
import { resolveClassesToCss } from './tw/resolver';

export type ClassResolver = (classes: string[]) => Promise<string>;

export interface TailwindConversion {
	sass: string;
	unknownClasses: string[];
}

/** Convert one markup document (HTML / JSX-ish / Svelte template) to nested Sass. */
export async function convertTailwind(
	html: string,
	resolve: ClassResolver = resolveClassesToCss
): Promise<TailwindConversion> {
	const tree = parseMarkup(html);
	const classes = [...collectClasses(tree)];
	if (classes.length === 0) return { sass: '', unknownClasses: [] };
	const css = await resolve(classes);
	const { classMap, keyframes } = extractUtilities(css, new Set(classes));
	return renderTree(tree, classMap, keyframes);
}

/** Build Sass from an already-parsed tree + an already-extracted class map
 *  (used by the CLI to resolve every file's classes in a single compile). */
export function renderTree(
	tree: ElementNode[],
	classMap: Map<string, UtilityRule[]>,
	keyframes: SassNode[] = []
): TailwindConversion {
	const { nodes, unknownClasses } = buildSassTree(tree, classMap, keyframes);
	return { sass: emitSass(nodes).trim(), unknownClasses: [...unknownClasses] };
}

/** Convert a flat list of Tailwind classes into a single Sass block under
 *  `selector` (variants nest as `&:hover` / `@media`). Used for class-list and
 *  `@apply` inputs. */
export async function convertClassList(
	classes: string[],
	selector = 'generated',
	resolve: ClassResolver = resolveClassesToCss
): Promise<TailwindConversion> {
	const clean = classes.filter(Boolean);
	if (clean.length === 0) return { sass: '', unknownClasses: [] };
	const css = await resolve(clean);
	const { classMap, keyframes } = extractUtilities(css, new Set(clean));
	// Represent the class list as one synthetic element so the DOM-nesting builder
	// produces the block, its state variants and responsive blocks for free.
	const tree: ElementNode[] = [{ tag: selector, classes: clean, children: [] }];
	return renderTree(tree, classMap, keyframes);
}

/** Just the Sass string. */
export async function convertTailwindToSass(html: string, resolve?: ClassResolver): Promise<string> {
	return (await convertTailwind(html, resolve)).sass;
}
