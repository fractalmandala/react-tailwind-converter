// `@apply` expansion for CSS/SCSS files. Each rule that uses `@apply a b c` is
// turned into a Sass block with those utilities resolved to real declarations,
// its own literal declarations preserved, and any state/responsive variants of
// the applied classes nested underneath.
import postcss from 'postcss';
import { emitSass, type SassNode, type UtilityRule } from './engine';
import { buildSassTree } from './build';

/** Every class token referenced by an `@apply` in the file (for the candidate set). */
export function collectApplyTokens(cssText: string): string[] {
	const tokens: string[] = [];
	try {
		postcss.parse(cssText).walkAtRules('apply', (atrule) => {
			for (const t of atrule.params.split(/\s+/)) if (t) tokens.push(t.replace(/!$/, ''));
		});
	} catch {
		/* not valid CSS — caller falls back to class-list mode */
	}
	return tokens;
}

export function hasApply(cssText: string): boolean {
	return /@apply\b/.test(cssText);
}

export function expandApply(cssText: string, classMap: Map<string, UtilityRule[]>): string {
	const root = postcss.parse(cssText);
	const out: SassNode[] = [];

	root.each((node) => {
		if (node.type !== 'rule') return;
		const applied: string[] = [];
		const literal: SassNode[] = [];
		node.each((child) => {
			if (child.type === 'atrule' && child.name === 'apply') {
				for (const t of child.params.split(/\s+/)) if (t) applied.push(t.replace(/!$/, ''));
			} else if (child.type === 'decl') {
				literal.push({ kind: 'decl', prop: child.prop, value: child.value });
			}
		});
		if (applied.length === 0 && literal.length === 0) return;

		let appliedDecls: SassNode[] = [];
		let appliedVariants: SassNode[] = [];
		if (applied.length) {
			const { nodes } = buildSassTree([{ tag: 'x', classes: applied, children: [] }], classMap);
			const block = nodes[0];
			if (block && block.kind === 'rule') {
				appliedDecls = block.children.filter((c) => c.kind === 'decl');
				appliedVariants = block.children.filter((c) => c.kind !== 'decl');
			}
		}
		// applied base first, then the rule's own declarations (which win on
		// conflict, matching @apply semantics), then variant/responsive nests.
		out.push({ kind: 'rule', selector: node.selector, children: [...appliedDecls, ...literal, ...appliedVariants] });
	});

	return emitSass(out).trim();
}
