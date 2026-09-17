// Element tree + class→rules map → nested Sass tree.
//
// Nesting mirrors the DOM: an element's variant states (`&:hover`), responsive
// blocks (`@media`) and child elements all nest inside its selector. Selector
// names come from a real (non-utility) class when the element has one, else a
// deduped synthetic class from the tag name.
import type { ElementNode } from './markup';
import type { SassNode, UtilityRule } from './engine';

export interface BuildResult {
	nodes: SassNode[];
	/** classes that produced no Tailwind rule — surfaced to the caller as info. */
	unknownClasses: Set<string>;
}

export function buildSassTree(
	tree: ElementNode[],
	classMap: Map<string, UtilityRule[]>,
	keyframes: SassNode[] = []
): BuildResult {
	const unknownClasses = new Set<string>();

	const isUtility = (cls: string) => classMap.has(cls);

	const buildElement = (el: ElementNode, usedSiblings: Set<string>): SassNode | null => {
		const utilityClasses = el.classes.filter(isUtility);
		const semanticClasses = el.classes.filter((c) => !isUtility(c));
		for (const c of semanticClasses) unknownClasses.add(c);

		// base (unconditional) declarations, later utilities winning on conflict
		const base = new Map<string, string>();
		// variant groups keyed by media|||suffix, decls preserving order + last-wins
		const suffixGroups = new Map<string, { suffix: string; decls: Map<string, string> }>();
		const mediaGroups = new Map<string, { media: string; suffix: string; decls: Map<string, string> }>();

		for (const cls of utilityClasses) {
			for (const rule of classMap.get(cls)!) {
				if (rule.media === null && rule.suffix === '') {
					for (const [p, v] of rule.decls) base.set(p, v);
				} else if (rule.media === null) {
					const g = suffixGroups.get(rule.suffix) ?? { suffix: rule.suffix, decls: new Map() };
					for (const [p, v] of rule.decls) g.decls.set(p, v);
					suffixGroups.set(rule.suffix, g);
				} else {
					const key = rule.media + '|||' + rule.suffix;
					const g = mediaGroups.get(key) ?? { media: rule.media, suffix: rule.suffix, decls: new Map() };
					for (const [p, v] of rule.decls) g.decls.set(p, v);
					mediaGroups.set(key, g);
				}
			}
		}

		// recurse into children first, so we know if this element must exist as a wrapper
		const childUsed = new Set<string>();
		const childNodes: SassNode[] = [];
		for (const child of el.children) {
			const built = buildElement(child, childUsed);
			if (built) childNodes.push(built);
		}

		const hasOwnStyle = base.size > 0 || suffixGroups.size > 0 || mediaGroups.size > 0;
		if (!hasOwnStyle && childNodes.length === 0) return null;

		// selector name: first real class, else a deduped synthetic class from the tag
		let name = semanticClasses[0] ?? el.tag;
		let selector = '.' + name;
		if (usedSiblings.has(selector)) {
			let n = 2;
			while (usedSiblings.has(`.${name}-${n}`)) n++;
			selector = `.${name}-${n}`;
		}
		usedSiblings.add(selector);

		const children: SassNode[] = [];
		for (const [prop, value] of base) children.push({ kind: 'decl', prop, value });
		// pseudo/state variants before responsive blocks
		for (const g of suffixGroups.values()) {
			children.push({
				kind: 'rule',
				selector: '&' + g.suffix,
				children: [...g.decls].map(([prop, value]) => ({ kind: 'decl', prop, value }) as SassNode)
			});
		}
		for (const g of mediaGroups.values()) {
			const decls = [...g.decls].map(([prop, value]) => ({ kind: 'decl', prop, value }) as SassNode);
			children.push({
				kind: 'atrule',
				name: 'media',
				params: g.media,
				children: g.suffix ? [{ kind: 'rule', selector: '&' + g.suffix, children: decls }] : decls
			});
		}
		children.push(...childNodes);

		return { kind: 'rule', selector, children };
	};

	const used = new Set<string>();
	const nodes: SassNode[] = [];
	for (const el of tree) {
		const built = buildElement(el, used);
		if (built) nodes.push(built);
	}
	nodes.push(...keyframes);
	return { nodes, unknownClasses };
}
