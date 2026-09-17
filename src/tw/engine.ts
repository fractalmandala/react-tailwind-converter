// Tailwind → Sass engine (pure, environment-agnostic).
//
// Given (a) the CSS that the *real* Tailwind v4 compiler produced for a set of
// candidate classes and (b) a parsed markup tree, this turns them into nested
// indented Sass whose structure mirrors the DOM. There is no hand-authored
// utility table anywhere: every declaration comes from Tailwind itself.
//
// Split into small pure functions so each is unit-testable in Node against a
// fixed CSS string, without a browser or the Tailwind runtime.
import postcss, { type ChildNode, type Container } from 'postcss';

// --- normalized output tree ---------------------------------------------------

export type SassNode =
	| { kind: 'decl'; prop: string; value: string }
	| { kind: 'rule'; selector: string; children: SassNode[] }
	| { kind: 'atrule'; name: string; params: string; children: SassNode[] };

// One generated rule for a single utility class, relative to the element that
// carries it: `suffix` is the selector part after the base class (`:hover`,
// `:is(...)`, or ''), `media` is the enclosing @media query (or null).
export interface UtilityRule {
	media: string | null;
	suffix: string;
	decls: Array<[string, string]>;
}

export interface Extracted {
	classMap: Map<string, UtilityRule[]>;
	themeVars: Map<string, string>;
	keyframes: SassNode[];
}

// --- theme variable inlining --------------------------------------------------
// Tailwind emits utilities that reference theme tokens (`var(--spacing)`,
// `var(--color-teal-500)`), with the values declared once in a `:root` block.
// For raw-value output we substitute them back in. `--tw-*` runtime props are
// left as-is: they are declared inline in the same rule and are real plumbing.

const VAR_CALL = /var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,([^]*))?\)/;

/** Resolve `var(--x)` / `var(--x, fallback)` against the theme map, recursively,
 *  matching balanced parens so nested `var()`/`calc()` fallbacks survive. */
export function inlineVars(value: string, vars: Map<string, string>, depth = 0): string {
	if (depth > 10 || !value.includes('var(')) return value;
	let out = '';
	let i = 0;
	while (i < value.length) {
		const start = value.indexOf('var(', i);
		if (start === -1) {
			out += value.slice(i);
			break;
		}
		out += value.slice(i, start);
		// find the matching close paren for this var(
		let depthParen = 0;
		let j = start + 3; // at '('
		let end = -1;
		for (; j < value.length; j++) {
			if (value[j] === '(') depthParen++;
			else if (value[j] === ')') {
				depthParen--;
				if (depthParen === 0) {
					end = j;
					break;
				}
			}
		}
		if (end === -1) {
			out += value.slice(start);
			break;
		}
		const inner = value.slice(start + 4, end); // between the outer parens
		const comma = topLevelComma(inner);
		const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
		const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
		if (vars.has(name)) {
			out += inlineVars(vars.get(name)!, vars, depth + 1);
		} else if (fallback !== null) {
			out += inlineVars(fallback, vars, depth + 1);
		} else {
			out += value.slice(start, end + 1); // unknown (e.g. --tw-*): keep verbatim
		}
		i = end + 1;
	}
	return out;
}

/** Collapse the runs of whitespace left behind when empty `var(--tw-*,)` slots
 *  inline to nothing (e.g. `filter: blur(1px)      ` → `filter: blur(1px)`). */
function collapseWs(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function topLevelComma(s: string): number {
	let depth = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (c === ',' && depth === 0) return i;
	}
	return -1;
}

// --- selector parsing ---------------------------------------------------------
// Split a generated selector into the base candidate class and the suffix that
// follows it. The class name is escaped (`.hover\:bg-black\/50:hover`), so we
// walk char by char, treating `\x` as a literal x, and stop at the first
// UNescaped selector boundary — that boundary begins the suffix.

const BOUNDARY = new Set([':', '[', ' ', '>', '+', '~', ',', '(', ')', '*']);

export function splitSelector(selector: string): { base: string; suffix: string } | null {
	if (!selector.startsWith('.')) return null;
	let base = '';
	let i = 1;
	for (; i < selector.length; i++) {
		const c = selector[i];
		if (c === '\\') {
			if (i + 1 < selector.length) {
				base += selector[i + 1];
				i++;
			}
			continue;
		}
		if (BOUNDARY.has(c)) break;
		base += c;
	}
	return { base, suffix: selector.slice(i) };
}

// --- extraction ---------------------------------------------------------------

/** Parse the compiler's CSS into a class→rules map, the theme vars, and any
 *  top-level @keyframes. `candidates` scopes attribution to real classes. */
export function extractUtilities(css: string, candidates: Set<string>): Extracted {
	const root = postcss.parse(css);
	const themeVars = new Map<string, string>();
	const classMap = new Map<string, UtilityRule[]>();
	const keyframes: SassNode[] = [];

	// 1. theme vars from any :root / :host block
	root.walkRules((rule) => {
		if (!/(^|,)\s*(:root|:host)\b/.test(rule.selector)) return;
		rule.each((node) => {
			if (node.type === 'decl' && node.prop.startsWith('--')) themeVars.set(node.prop, node.value);
		});
	});
	// @property initial-values are the defaults for Tailwind's runtime custom
	// properties (`--tw-border-style: solid`), so a utility that reads one before
	// any sibling sets it resolves to the declared default rather than staying a
	// bare var(). Theme vars win over these defaults.
	root.walkAtRules('property', (atrule) => {
		const name = atrule.params.trim();
		let initial: string | undefined;
		atrule.walkDecls('initial-value', (d) => {
			initial = d.value;
		});
		if (initial !== undefined && !themeVars.has(name)) themeVars.set(name, initial);
	});

	const addRule = (base: string, media: string | null, suffix: string, decls: Array<[string, string]>) => {
		if (!candidates.has(base) || decls.length === 0) return;
		if (!classMap.has(base)) classMap.set(base, []);
		classMap.get(base)!.push({ media, suffix, decls });
	};

	// Collect declarations directly on a rule (not nested containers), resolving
	// values against theme vars plus the rule's OWN custom properties. Tailwind
	// composes effects through runtime `--tw-*` props set alongside the property
	// that reads them (`--tw-blur: blur(175px); filter: var(--tw-blur,) …`), so
	// those must be resolved from the sibling declaration, then dropped as
	// plumbing — leaving a single clean `filter: blur(175px)`.
	const declsOf = (rule: Container): Array<[string, string]> => {
		const local = new Map(themeVars);
		rule.each((n) => {
			if (n.type === 'decl' && n.prop.startsWith('--')) local.set(n.prop, inlineVars(n.value, local));
		});
		const out: Array<[string, string]> = [];
		rule.each((n) => {
			if (n.type !== 'decl') return;
			if (n.prop.startsWith('--tw-')) return; // runtime plumbing, already inlined
			out.push([n.prop, collapseWs(inlineVars(n.value, local))]);
		});
		return out;
	};

	// walk a container, flattening @supports/@media into (media, rule) pairs
	const walk = (container: Container, media: string | null) => {
		container.each((node) => {
			if (node.type === 'rule') {
				if (/(^|,)\s*(:root|:host)\b/.test(node.selector)) return;
				const parts = splitSelector(node.selector);
				if (parts) addRule(parts.base, media, parts.suffix, declsOf(node));
				return;
			}
			if (node.type === 'atrule') {
				if (node.name === 'property') return; // runtime @property plumbing
				if (node.name === 'keyframes') {
					keyframes.push(atruleToSass(node, themeVars));
					return;
				}
				if (node.name === 'layer' && node.params === 'properties') return;
				if (node.name === 'media') {
					walk(node, node.params);
					return;
				}
				if (node.name === 'supports') {
					walk(node, media); // flatten enhancement into its parent context
					return;
				}
				if (node.name === 'layer') {
					walk(node, media); // @layer wrapper — descend
					return;
				}
			}
		});
	};

	walk(root, null);
	return { classMap, themeVars, keyframes };
}

// --- generic postcss → sass (used for @keyframes) -----------------------------

function nodeToSass(node: ChildNode, vars: Map<string, string>): SassNode | null {
	if (node.type === 'decl') return { kind: 'decl', prop: node.prop, value: inlineVars(node.value, vars) };
	if (node.type === 'rule') return { kind: 'rule', selector: node.selector, children: childrenToSass(node, vars) };
	if (node.type === 'atrule') return atruleToSass(node, vars);
	return null;
}

function childrenToSass(container: Container, vars: Map<string, string>): SassNode[] {
	const out: SassNode[] = [];
	container.each((n) => {
		const s = nodeToSass(n as ChildNode, vars);
		if (s) out.push(s);
	});
	return out;
}

function atruleToSass(atrule: import('postcss').AtRule, vars: Map<string, string>): SassNode {
	return { kind: 'atrule', name: atrule.name, params: atrule.params, children: childrenToSass(atrule, vars) };
}

// --- emit indented Sass -------------------------------------------------------

export function emitSass(nodes: SassNode[], indent = 0, topLevel = true): string {
	const lines: string[] = [];
	const pad = '\t'.repeat(indent);
	for (const node of nodes) {
		if (node.kind === 'decl') {
			lines.push(`${pad}${node.prop}: ${node.value}`);
		} else {
			const header = node.kind === 'rule' ? node.selector : `@${node.name}${node.params ? ' ' + node.params : ''}`;
			lines.push(`${pad}${header}`);
			lines.push(emitSass(node.children, indent + 1, false));
			if (topLevel) lines.push('');
		}
	}
	return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
