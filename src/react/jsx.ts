// JSX (Babel AST) → Svelte 5 template markup.
//
// Walks the real JSX AST rather than pattern-matching strings, so nested
// conditionals, `.map`, fragments and mixed children serialize correctly.
// Control flow becomes Svelte blocks: `a && <x/>` → {#if}, `c ? a : b` →
// {#if}{:else}, `arr.map(i => <x/>)` → {#each}. React-isms are normalized
// (className→class, onClick→onclick, style object→string, ref→bind:this).
import * as t from '@babel/types';

export interface JsxCtx {
	gen: (node: t.Node) => string;
	domRefs: Set<string>;
	warnings: string[];
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function jsxName(node: t.JSXIdentifier | t.JSXMemberExpression | t.JSXNamespacedName): string {
	if (t.isJSXIdentifier(node)) return node.name;
	if (t.isJSXMemberExpression(node)) return `${jsxName(node.object)}.${node.property.name}`;
	return `${node.namespace.name}:${node.name.name}`;
}

function eventName(name: string): string {
	// onClick → onclick, onKeyDown → onkeydown, onChange → oninput (closest Svelte)
	if (name === 'onChange') return 'oninput';
	if (/^on[A-Z]/.test(name)) return name.toLowerCase();
	return name;
}

// React attribute spellings → HTML/Svelte. SVG camelCase attrs (viewBox,
// preserveAspectRatio, …) are intentionally NOT mapped, so they pass through.
const ATTR_MAP: Record<string, string> = {
	className: 'class',
	htmlFor: 'for',
	readOnly: 'readonly',
	tabIndex: 'tabindex',
	autoFocus: 'autofocus',
	autoComplete: 'autocomplete',
	autoPlay: 'autoplay',
	spellCheck: 'spellcheck',
	contentEditable: 'contenteditable',
	crossOrigin: 'crossorigin',
	noValidate: 'novalidate',
	maxLength: 'maxlength',
	minLength: 'minlength',
	colSpan: 'colspan',
	rowSpan: 'rowspan',
	encType: 'enctype',
	formAction: 'formaction'
};

function attrName(name: string): string {
	if (ATTR_MAP[name]) return ATTR_MAP[name];
	if (/^on[A-Z]/.test(name)) return eventName(name);
	return name;
}

function kebab(s: string): string {
	return s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/^ms-/, '-ms-').toLowerCase();
}

/** style={{ marginTop: 4, color: c }} → style="margin-top: 4px; color: {c}" */
function styleObject(expr: t.ObjectExpression, ctx: JsxCtx): string {
	const parts: string[] = [];
	for (const prop of expr.properties) {
		if (!t.isObjectProperty(prop) || prop.computed) continue;
		const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : null;
		if (!key) continue;
		const p = kebab(key);
		const v = prop.value;
		if (t.isStringLiteral(v)) parts.push(`${p}: ${v.value}`);
		else if (t.isNumericLiteral(v)) parts.push(`${p}: ${v.value}${unitless(p) ? '' : 'px'}`);
		else parts.push(`${p}: {${ctx.gen(v)}}`);
	}
	return parts.join('; ');
}
function unitless(prop: string): boolean {
	return ['opacity', 'z-index', 'font-weight', 'line-height', 'flex', 'flex-grow', 'flex-shrink', 'order'].includes(prop);
}

/** Detect `value={v} onChange={e => (v = e.target.value)}` (the setter has
 *  already been rewritten to an assignment) and collapse it to `bind:value`.
 *  Same for `checked` → `bind:checked`. Returns the bind attribute plus the two
 *  source attributes it consumes. */
function detectBind(node: t.JSXOpeningElement): { attr: string; consumed: t.JSXAttribute[] } | null {
	let valueAttr: t.JSXAttribute | undefined;
	let changeAttr: t.JSXAttribute | undefined;
	let kind: 'value' | 'checked' | null = null;
	let name: string | null = null;
	for (const a of node.attributes) {
		if (!t.isJSXAttribute(a) || !a.value || !t.isJSXExpressionContainer(a.value)) continue;
		const an = jsxName(a.name);
		const e = a.value.expression;
		if ((an === 'value' || an === 'checked') && t.isIdentifier(e)) {
			valueAttr = a; kind = an; name = e.name;
		} else if (an === 'onChange' || an === 'onInput') {
			changeAttr = a;
		}
	}
	if (!valueAttr || !changeAttr || !kind || !name) return null;
	const handler = (changeAttr.value as t.JSXExpressionContainer).expression;
	if (!t.isArrowFunctionExpression(handler) && !t.isFunctionExpression(handler)) return null;
	const body = t.isBlockStatement(handler.body)
		? handler.body.body.length === 1 && t.isExpressionStatement(handler.body.body[0])
			? handler.body.body[0].expression
			: null
		: handler.body;
	if (!body || !t.isAssignmentExpression(body) || body.operator !== '=') return null;
	if (!t.isIdentifier(body.left, { name })) return null;
	const rhs = body.right;
	const prop = kind === 'checked' ? 'checked' : 'value';
	if (!t.isMemberExpression(rhs) || !t.isIdentifier(rhs.property, { name: prop })) return null;
	return { attr: `bind:${kind}={${name}}`, consumed: [valueAttr, changeAttr] };
}

function attributes(node: t.JSXOpeningElement, ctx: JsxCtx): { attrs: string[]; html: string | null } {
	const attrs: string[] = [];
	let html: string | null = null;
	const bind = detectBind(node);
	const consumed = new Set<t.JSXAttribute>(bind?.consumed ?? []);
	if (bind) attrs.push(bind.attr);
	for (const attr of node.attributes) {
		if (t.isJSXAttribute(attr) && consumed.has(attr)) continue;
		if (t.isJSXSpreadAttribute(attr)) {
			attrs.push(`{...${ctx.gen(attr.argument)}}`);
			continue;
		}
		const name = jsxName(attr.name);
		const value = attr.value;

		if (name === 'key') continue; // consumed by {#each (key)}
		if (name === 'ref' && value && t.isJSXExpressionContainer(value) && t.isIdentifier(value.expression)) {
			ctx.domRefs.add(value.expression.name);
			attrs.push(`bind:this={${value.expression.name}}`);
			continue;
		}
		if (name === 'dangerouslySetInnerHTML' && value && t.isJSXExpressionContainer(value) && t.isObjectExpression(value.expression)) {
			const htmlProp = value.expression.properties.find(
				(p) => t.isObjectProperty(p) && t.isIdentifier(p.key, { name: '__html' })
			) as t.ObjectProperty | undefined;
			if (htmlProp) html = ctx.gen(htmlProp.value as t.Expression);
			continue;
		}

		const outName = attrName(name);

		if (value == null) {
			attrs.push(outName); // boolean attribute
		} else if (t.isStringLiteral(value)) {
			attrs.push(`${outName}="${value.value}"`);
		} else if (t.isJSXExpressionContainer(value)) {
			const e = value.expression;
			if (t.isJSXEmptyExpression(e)) continue;
			if (name === 'style' && t.isObjectExpression(e)) {
				attrs.push(`style="${styleObject(e, ctx)}"`);
			} else if (t.isBooleanLiteral(e)) {
				if (e.value) attrs.push(outName);
			} else {
				attrs.push(`${outName}={${ctx.gen(e)}}`);
			}
		}
	}
	return { attrs, html };
}

function isJsx(node: t.Node): boolean {
	return t.isJSXElement(node) || t.isJSXFragment(node);
}

/** Serialize a child expression container, turning React control flow into
 *  Svelte blocks. Returns markup. */
function expressionChild(expr: t.Expression, ctx: JsxCtx, indent: string): string {
	// arr.map((item, i) => <x/>)
	if (t.isCallExpression(expr) && t.isMemberExpression(expr.callee) && t.isIdentifier(expr.callee.property, { name: 'map' })) {
		const arr = ctx.gen(expr.callee.object);
		const fn = expr.arguments[0];
		if (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) {
			const item = fn.params[0] && t.isIdentifier(fn.params[0]) ? fn.params[0].name : 'item';
			const idx = fn.params[1] && t.isIdentifier(fn.params[1]) ? fn.params[1].name : null;
			const body = arrowBody(fn);
			const key = body && t.isJSXElement(body) ? keyOf(body) : null;
			const inner = body ? renderNode(body, ctx, indent + '\t') : '';
			const head = `${arr} as ${item}${idx ? `, ${idx}` : ''}${key ? ` (${key})` : ''}`;
			return `${indent}{#each ${head}}\n${inner}\n${indent}{/each}`;
		}
	}
	// cond ? <a/> : <b/>
	if (t.isConditionalExpression(expr)) {
		const cons = renderNode(expr.consequent, ctx, indent + '\t');
		const alt = renderNode(expr.alternate, ctx, indent + '\t');
		return `${indent}{#if ${ctx.gen(expr.test)}}\n${cons}\n${indent}{:else}\n${alt}\n${indent}{/if}`;
	}
	// cond && <x/>
	if (t.isLogicalExpression(expr) && expr.operator === '&&') {
		const cons = renderNode(expr.right, ctx, indent + '\t');
		return `${indent}{#if ${ctx.gen(expr.left)}}\n${cons}\n${indent}{/if}`;
	}
	// plain interpolation
	return `${indent}{${ctx.gen(expr)}}`;
}

/** Render any node that can appear where markup is expected (JSX or expression). */
function renderNode(node: t.Node, ctx: JsxCtx, indent: string): string {
	if (t.isJSXElement(node)) return element(node, ctx, indent);
	if (t.isJSXFragment(node)) return children(node.children, ctx, indent);
	if (t.isParenthesizedExpression(node)) return renderNode(node.expression, ctx, indent);
	if (isExpression(node)) return expressionChild(node as t.Expression, ctx, indent);
	return `${indent}{/* ${node.type} */}`;
}

function isExpression(node: t.Node): boolean {
	return t.isExpression(node);
}

function element(node: t.JSXElement, ctx: JsxCtx, indent: string): string {
	const open = node.openingElement;
	const tag = jsxName(open.name);
	const { attrs, html } = attributes(open, ctx);
	const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';
	const kids = html != null ? `${indent}\t{@html ${html}}` : children(node.children, ctx, indent + '\t');

	if (!kids.trim()) {
		if (VOID.has(tag)) return `${indent}<${tag}${attrStr} />`;
		return `${indent}<${tag}${attrStr}></${tag}>`;
	}
	// keep short, single-line content on one line: <h1>{title}</h1>
	if (!kids.includes('\n')) return `${indent}<${tag}${attrStr}>${kids.trim()}</${tag}>`;
	return `${indent}<${tag}${attrStr}>\n${kids}\n${indent}</${tag}>`;
}

/** A JSX expression that becomes a Svelte block ({#if}/{#each}) rather than
 *  inline interpolation. */
function isBlockExpr(expr: t.Expression): boolean {
	if (t.isLogicalExpression(expr) && expr.operator === '&&') return true;
	if (t.isConditionalExpression(expr)) return true;
	if (t.isCallExpression(expr) && t.isMemberExpression(expr.callee) && t.isIdentifier(expr.callee.property, { name: 'map' })) return true;
	return false;
}

function children(nodes: t.Node[], ctx: JsxCtx, indent: string): string {
	const lines: string[] = [];
	let inline: string[] = [];
	const flush = () => {
		const joined = inline.join('').replace(/[ \t]+/g, ' ').trim();
		if (joined) lines.push(indent + joined);
		inline = [];
	};
	for (const child of nodes) {
		if (t.isJSXText(child)) {
			// whitespace-only text containing a newline is formatting between
			// block children, not content — it ends the current inline run.
			if (child.value.trim() === '') {
				if (/\n/.test(child.value)) flush();
				else if (inline.length) inline.push(' ');
				continue;
			}
			inline.push(child.value.replace(/\s+/g, ' '));
		} else if (t.isJSXExpressionContainer(child)) {
			if (t.isJSXEmptyExpression(child.expression)) continue;
			if (isBlockExpr(child.expression)) {
				flush();
				lines.push(expressionChild(child.expression, ctx, indent));
			} else {
				inline.push(`{${ctx.gen(child.expression)}}`);
			}
		} else if (t.isJSXElement(child) || t.isJSXFragment(child)) {
			flush();
			lines.push(renderNode(child, ctx, indent));
		}
	}
	flush();
	return lines.join('\n');
}

function arrowBody(fn: t.ArrowFunctionExpression | t.FunctionExpression): t.Node | null {
	if (t.isBlockStatement(fn.body)) {
		// find the returned JSX
		for (const stmt of fn.body.body) if (t.isReturnStatement(stmt) && stmt.argument) return unwrap(stmt.argument);
		return null;
	}
	return unwrap(fn.body);
}
function unwrap(node: t.Node): t.Node {
	return t.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}
function keyOf(el: t.JSXElement): string | null {
	for (const attr of el.openingElement.attributes) {
		if (t.isJSXAttribute(attr) && jsxName(attr.name) === 'key' && attr.value && t.isJSXExpressionContainer(attr.value)) {
			const jsxCtx = attr.value.expression;
			if (!t.isJSXEmptyExpression(jsxCtx)) return keyGen(jsxCtx);
		}
	}
	return null;
}
// keyGen is injected via a module-level hook so we don't need a generator here.
let keyGen: (n: t.Node) => string = () => '';
export function setKeyGen(fn: (n: t.Node) => string) {
	keyGen = fn;
}

/** Entry point: render the component's returned JSX to a Svelte template. */
export function jsxToSvelte(node: t.Node, ctx: JsxCtx): string {
	setKeyGen(ctx.gen);
	return renderNode(unwrap(node), ctx, '').replace(/\n{3,}/g, '\n\n');
}
