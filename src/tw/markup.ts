// Markup → element tree. Uses node-html-parser, which runs in both the browser
// and Node (so the whole pipeline is unit-testable without a DOM). Accepts real
// HTML as well as JSX-ish markup: `className` is read as `class`, and dynamic
// class expressions (`class={...}`, `class="a {cond}"`) contribute their static
// tokens only.
import { parse, type HTMLElement } from 'node-html-parser';

export interface ElementNode {
	tag: string;
	classes: string[];
	children: ElementNode[];
}

/** Pull the static class tokens out of a raw attribute value, dropping any
 *  `{...}` expression segments (JSX/Svelte) while keeping literal class names. */
export function staticClassTokens(raw: string): string[] {
	// remove balanced {...} expression chunks
	let cleaned = '';
	let depth = 0;
	for (const ch of raw) {
		if (ch === '{') depth++;
		else if (ch === '}') depth = Math.max(0, depth - 1);
		else if (depth === 0) cleaned += ch;
	}
	return cleaned.split(/\s+/).map((c) => c.trim()).filter(Boolean);
}

function classesOf(el: HTMLElement): string[] {
	const raw = el.getAttribute('class') ?? el.getAttribute('className') ?? '';
	return staticClassTokens(raw);
}

function toNode(el: HTMLElement): ElementNode {
	const children: ElementNode[] = [];
	for (const child of el.childNodes) {
		// node-html-parser: element nodes have a `tagName`
		if ((child as HTMLElement).nodeType === 1) children.push(toNode(child as HTMLElement));
	}
	return { tag: (el.tagName ?? 'div').toLowerCase(), classes: classesOf(el), children };
}

export function parseMarkup(html: string): ElementNode[] {
	const root = parse(html, { comment: false });
	const out: ElementNode[] = [];
	for (const child of root.childNodes) {
		if ((child as HTMLElement).nodeType === 1) out.push(toNode(child as HTMLElement));
	}
	return out;
}

/** Every static class token across the whole tree (for the compiler candidate set). */
export function collectClasses(nodes: ElementNode[], acc = new Set<string>()): Set<string> {
	for (const node of nodes) {
		for (const c of node.classes) acc.add(c);
		collectClasses(node.children, acc);
	}
	return acc;
}
