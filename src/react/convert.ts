// React (TSX/JSX) → Svelte 5, on the Babel AST.
//
// Parses with @babel/parser, transforms hooks → runes and setter calls →
// assignments on the tree, serializes the returned JSX to a Svelte template,
// and re-emits the surviving logic as a <script>. Everything structural is done
// on the AST; strings are only produced at the very end by @babel/generator.
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { jsxToSvelte, type JsxCtx } from './jsx';

// Babel ships these as interop default exports.
const traverse = ((_traverse as any).default ?? _traverse) as typeof _traverse;
const generate = ((_generate as any).default ?? _generate) as typeof _generate;

export interface ConversionResult {
	svelte: string;
	warnings: string[];
}

const gen = (node: t.Node): string => generate(node, { concise: false, jsescOption: { minimal: true } }).code;
// Template-embedded expressions (event handlers, {interpolations}) read better on
// one line, so the JSX serializer uses a concise generator.
const genInline = (node: t.Node): string => generate(node, { concise: true, jsescOption: { minimal: true } }).code.replace(/;\s*$/, '');

export function convertReactToSvelte(code: string): ConversionResult {
	const warnings: string[] = [];
	const ast = parse(code, {
		sourceType: 'module',
		plugins: ['typescript', 'jsx']
	});

	const found = findComponent(ast);
	if (!found) {
		return { svelte: '<!-- react2svelte: no React component (a function returning JSX) found -->', warnings: ['no component found'] };
	}
	const { func, name, topNode } = found;

	// 1. Collect state/setters up front so the rewrite pass can see every setter.
	const stateNames = new Map<string, string>(); // setter → state
	const bodyStatements = t.isBlockStatement(func.body) ? func.body.body : [];
	for (const stmt of bodyStatements) {
		const hook = matchHook(stmt);
		if (hook?.kind === 'state') stateNames.set(hook.setter!, hook.name);
	}

	// 2. Rewrite setX(v) → x = v  (or x = <updater applied>) across the whole file.
	traverse(ast, {
		CallExpression(path) {
			const callee = path.node.callee;
			if (!t.isIdentifier(callee) || !stateNames.has(callee.name)) return;
			const state = stateNames.get(callee.name)!;
			const arg = path.node.arguments[0];
			let rhs: t.Expression;
			if (arg && (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg))) {
				rhs = updaterToExpression(arg, state);
			} else {
				rhs = (arg as t.Expression) ?? t.identifier('undefined');
			}
			path.replaceWith(t.assignmentExpression('=', t.identifier(state), rhs));
			path.skip();
		}
	});

	// 3. Walk the (rewritten) component body, turning hooks into runes and
	//    keeping everything else in source order.
	const domRefs = new Set<string>();
	const svelteImports = new Set<string>();
	const scriptLines: string[] = [];
	let jsxReturn: t.Node | null = null;

	for (const stmt of bodyStatements) {
		const hook = matchHook(stmt);
		if (!hook) {
			if (t.isReturnStatement(stmt) && stmt.argument && containsJsx(stmt.argument)) {
				jsxReturn = stmt.argument;
				continue;
			}
			const unknown = unknownHook(stmt);
			if (unknown) warnings.push(`unrecognized hook "${unknown}" left as-is — convert or inline it manually`);
			scriptLines.push(gen(stmt));
			continue;
		}
		switch (hook.kind) {
			case 'state':
				scriptLines.push(`let ${hook.name} = $state(${hook.init});`);
				break;
			case 'ref':
				scriptLines.push(`let ${hook.name} = $state(${hook.init || 'undefined'});`);
				break;
			case 'memo':
				scriptLines.push(hook.derivedBy ? `let ${hook.name} = $derived.by(() => ${hook.init});` : `let ${hook.name} = $derived(${hook.init});`);
				break;
			case 'callback':
				scriptLines.push(hook.fnText!);
				break;
			case 'effect':
				scriptLines.push(`$effect(() => ${hook.init});`);
				break;
			case 'reducer':
				scriptLines.push(`let ${hook.name} = $state(${hook.init});`);
				scriptLines.push(`function ${hook.dispatch}(action) {\n\t${hook.name} = ${hook.reducerName}(${hook.name}, action);\n}`);
				break;
			case 'context':
				svelteImports.add('getContext');
				scriptLines.push(`const ${hook.name} = getContext(${hook.contextArg});`);
				warnings.push(`useContext → getContext(${hook.contextArg}); make sure a parent runs setContext(${hook.contextArg}, …) (React's <Provider> is not converted)`);
				break;
		}
	}
	// arrow component with a bare JSX body (no hooks / block)
	if (!jsxReturn && !t.isBlockStatement(func.body) && containsJsx(func.body)) jsxReturn = func.body;

	// 4. DOM refs (used as ref={x}) that we typed as $state(undefined): fix the
	//    initializer, and strip `.current` off their reads in the script.
	const ctx: JsxCtx = { gen: genInline, domRefs, warnings };
	const template = jsxReturn ? jsxToSvelte(jsxReturn, ctx) : '<!-- react2svelte: no JSX returned -->';

	// 5. Props → $props(). Do this after we know the component's param shape.
	const propsBlock = buildProps(func, name, ast, warnings);

	// 6. Module-level declarations that aren't the component (types, helpers,
	//    child imports) — keep them, minus React imports.
	const moduleDecls = collectModuleDecls(ast, topNode);

	// 7. Rewrite `.current` for DOM refs across script lines.
	const importLine = svelteImports.size ? [`import { ${[...svelteImports].sort().join(', ')} } from 'svelte';`] : [];
	let script = [...importLine, ...moduleDecls, propsBlock, ...scriptLines].filter(Boolean).join('\n\n');
	script = cleanReactTypes(script, warnings);
	for (const ref of domRefs) {
		script = script.replace(new RegExp(`\\b${ref}\\.current\\b`, 'g'), ref);
		// ensure the ref is declared (it may have come from a value-less useRef)
		if (!new RegExp(`\\b(let|const)\\s+${ref}\\b`).test(script)) {
			script = `let ${ref} = $state<HTMLElement | null>(null);\n\n` + script;
		} else {
			script = script.replace(new RegExp(`let ${ref} = \\$state\\((undefined|null)\\);`), `let ${ref} = $state<HTMLElement | null>(null);`);
		}
	}

	const svelte = `<!-- ${name} — converted from React by react2svelte -->\n\n<script lang="ts">\n${indent(script)}\n</script>\n\n${template}\n`;
	return { svelte, warnings };
}

// --- component discovery ------------------------------------------------------

interface Found {
	func: t.FunctionDeclaration | t.ArrowFunctionExpression | t.FunctionExpression;
	name: string;
	topNode: t.Node; // the module statement that declares the component (to omit)
}

function findComponent(ast: t.File): Found | null {
	const body = ast.program.body;
	// export default function C() {}
	for (const stmt of body) {
		if (t.isExportDefaultDeclaration(stmt) && t.isFunctionDeclaration(stmt.declaration) && returnsJsx(stmt.declaration)) {
			return { func: stmt.declaration, name: stmt.declaration.id?.name ?? 'Component', topNode: stmt };
		}
	}
	// function C() {}  /  const C = () => {}
	for (const stmt of body) {
		const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
		if (t.isFunctionDeclaration(decl) && returnsJsx(decl)) return { func: decl, name: decl.id?.name ?? 'Component', topNode: stmt };
		if (t.isVariableDeclaration(decl)) {
			for (const d of decl.declarations) {
				if (t.isIdentifier(d.id) && d.init && (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init)) && returnsJsx(d.init)) {
					return { func: d.init, name: d.id.name, topNode: stmt };
				}
			}
		}
	}
	// export default identifier → find its declaration
	for (const stmt of body) {
		if (t.isExportDefaultDeclaration(stmt) && t.isIdentifier(stmt.declaration)) {
			const target = stmt.declaration.name;
			for (const s of body) {
				if (t.isVariableDeclaration(s)) {
					for (const d of s.declarations) {
						if (t.isIdentifier(d.id, { name: target }) && d.init && (t.isArrowFunctionExpression(d.init) || t.isFunctionExpression(d.init))) {
							return { func: d.init, name: target, topNode: s };
						}
					}
				}
			}
		}
	}
	return null;
}

function returnsJsx(fn: t.Function): boolean {
	if (!t.isBlockStatement(fn.body)) return containsJsx(fn.body);
	let has = false;
	for (const stmt of fn.body.body) if (t.isReturnStatement(stmt) && stmt.argument && containsJsx(stmt.argument)) has = true;
	return has;
}

function containsJsx(node: t.Node): boolean {
	if (t.isParenthesizedExpression(node)) return containsJsx(node.expression);
	return t.isJSXElement(node) || t.isJSXFragment(node);
}

// --- hook matching ------------------------------------------------------------

interface HookMatch {
	kind: 'state' | 'memo' | 'ref' | 'effect' | 'callback' | 'reducer' | 'context';
	name: string;
	setter?: string;
	init?: string;
	derivedBy?: boolean;
	fnText?: string;
	dispatch?: string; // reducer
	reducerName?: string; // reducer
	contextArg?: string; // context
}

function matchHook(stmt: t.Statement): HookMatch | null {
	// useEffect(() => {...}, deps)  — an expression statement
	if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression) && t.isIdentifier(stmt.expression.callee, { name: 'useEffect' })) {
		const fn = stmt.expression.arguments[0];
		if (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) {
			return { kind: 'effect', name: '', init: gen(fn.body) };
		}
	}
	if (!t.isVariableDeclaration(stmt) || stmt.declarations.length !== 1) return null;
	const d = stmt.declarations[0];
	if (!d.init || !t.isCallExpression(d.init) || !t.isIdentifier(d.init.callee)) return null;
	const hook = d.init.callee.name;
	const args = d.init.arguments;

	if (hook === 'useState' && t.isArrayPattern(d.id)) {
		const [a, b] = d.id.elements;
		const name = t.isIdentifier(a) ? a.name : 'value';
		const setter = t.isIdentifier(b) ? b.name : `set${cap(name)}`;
		return { kind: 'state', name, setter, init: args[0] ? gen(args[0]) : 'undefined' };
	}
	if (hook === 'useReducer' && t.isArrayPattern(d.id)) {
		const [a, b] = d.id.elements;
		const name = t.isIdentifier(a) ? a.name : 'state';
		const dispatch = t.isIdentifier(b) ? b.name : 'dispatch';
		const reducerName = args[0] ? gen(args[0]) : 'reducer';
		// useReducer(reducer, initialArg, init?) → init(initialArg) when a lazy
		// initializer is supplied, else the initial argument itself.
		const init = args[2] ? `${gen(args[2])}(${args[1] ? gen(args[1]) : ''})` : args[1] ? gen(args[1]) : 'undefined';
		return { kind: 'reducer', name, dispatch, reducerName, init };
	}
	if (hook === 'useContext' && t.isIdentifier(d.id)) {
		return { kind: 'context', name: d.id.name, contextArg: args[0] ? gen(args[0]) : 'undefined' };
	}
	if (hook === 'useRef' && t.isIdentifier(d.id)) {
		return { kind: 'ref', name: d.id.name, init: args[0] ? gen(args[0]) : '' };
	}
	if (hook === 'useMemo' && t.isIdentifier(d.id)) {
		const fn = args[0];
		if (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) {
			if (t.isBlockStatement(fn.body)) {
				const simple = singleReturn(fn.body);
				if (simple) return { kind: 'memo', name: d.id.name, init: gen(simple) };
				return { kind: 'memo', name: d.id.name, init: gen(fn.body), derivedBy: true };
			}
			return { kind: 'memo', name: d.id.name, init: gen(unparen(fn.body)) };
		}
	}
	if ((hook === 'useCallback' || hook === 'useMemo') && t.isIdentifier(d.id)) {
		const fn = args[0];
		if (t.isArrowFunctionExpression(fn) || t.isFunctionExpression(fn)) {
			// Build a real function declaration node so @babel/generator keeps the
			// TS param and return type annotations (generating a bare Identifier
			// param drops its type).
			const bodyBlock = t.isBlockStatement(fn.body)
				? fn.body
				: t.blockStatement([t.returnStatement(unparen(fn.body) as t.Expression)]);
			const decl = t.functionDeclaration(t.identifier(d.id.name), fn.params, bodyBlock, false, fn.async);
			decl.returnType = fn.returnType ?? null;
			return { kind: 'callback', name: d.id.name, fnText: gen(decl) };
		}
	}
	return null;
}

function singleReturn(block: t.BlockStatement): t.Node | null {
	if (block.body.length === 1 && t.isReturnStatement(block.body[0]) && block.body[0].argument) return unparen(block.body[0].argument);
	return null;
}
function unparen(node: t.Node): t.Node {
	return t.isParenthesizedExpression(node) ? unparen(node.expression) : node;
}

// --- setter updater → expression ---------------------------------------------

/** `prev => expr` applied to `state`: inline-substitute the param when it's a
 *  single identifier + expression body (idiomatic), else wrap in an IIFE. */
function updaterToExpression(fn: t.ArrowFunctionExpression | t.FunctionExpression, state: string): t.Expression {
	const param = fn.params[0];
	if (t.isIdentifier(param) && !t.isBlockStatement(fn.body)) {
		const clone = t.cloneNode(unparen(fn.body), true) as t.Expression;
		return substitute(clone, param.name, state);
	}
	// fallback: (updater)(state)
	return t.callExpression(t.parenthesizedExpression(fn), [t.identifier(state)]);
}

/** Replace free `from` identifiers with `to` inside an expression. Babel needs a
 *  Program/File to establish scope, so the expression is wrapped, traversed and
 *  unwrapped. */
function substitute(expr: t.Expression, from: string, to: string): t.Expression {
	const file = t.file(t.program([t.expressionStatement(expr)]));
	traverse(file, {
		Identifier(path) {
			if (path.node.name !== from) return;
			const parent = path.parent;
			if (t.isMemberExpression(parent) && parent.property === path.node && !parent.computed) return;
			if (t.isObjectProperty(parent) && parent.key === path.node && !parent.computed) return;
			path.node.name = to;
		}
	});
	return (file.program.body[0] as t.ExpressionStatement).expression;
}

// --- props --------------------------------------------------------------------

function buildProps(func: t.Function, name: string, ast: t.File, warnings: string[]): string {
	const param = func.params[0];
	if (!param) return '';
	const typeName = propsTypeName(param, ast);
	const names: string[] = [];
	let rest: string | null = null;
	let hasChildren = false;

	if (t.isObjectPattern(param)) {
		for (const p of param.properties) {
			if (t.isRestElement(p)) {
				rest = t.isIdentifier(p.argument) ? p.argument.name : 'rest';
				continue;
			}
			if (t.isObjectProperty(p)) {
				const key = t.isIdentifier(p.key) ? p.key.name : t.isStringLiteral(p.key) ? p.key.value : null;
				if (!key) continue;
				if (key === 'children') hasChildren = true;
				if (t.isAssignmentPattern(p.value)) names.push(`${key} = ${gen(p.value.right)}`);
				else names.push(key);
			}
		}
	} else if (t.isIdentifier(param)) {
		// props param used as an object — expose it whole
		const ann = typeName ? `: ${typeName}` : '';
		return `let ${param.name}${ann} = $props();`;
	}

	if (!hasChildren) names.push('children');
	if (rest) names.push(`...${rest}`);
	const annotation = typeName ? `: ${typeName}` : '';
	return `let { ${names.join(', ')} }${annotation} = $props();`;
}

function propsTypeName(param: t.Node, ast: t.File): string | null {
	// explicit annotation on the param
	if ((t.isObjectPattern(param) || t.isIdentifier(param)) && param.typeAnnotation && t.isTSTypeAnnotation(param.typeAnnotation)) {
		const ta = param.typeAnnotation.typeAnnotation;
		if (t.isTSTypeReference(ta) && t.isIdentifier(ta.typeName)) return ta.typeName.name;
	}
	// else a module-level interface/type named *Props
	for (const stmt of ast.program.body) {
		const decl = t.isExportNamedDeclaration(stmt) ? stmt.declaration : stmt;
		if (t.isTSInterfaceDeclaration(decl) && /Props$/.test(decl.id.name)) return decl.id.name;
		if (t.isTSTypeAliasDeclaration(decl) && /Props$/.test(decl.id.name)) return decl.id.name;
	}
	return null;
}

// --- module-level survivors ---------------------------------------------------

function collectModuleDecls(ast: t.File, componentNode: t.Node): string[] {
	const out: string[] = [];
	for (const stmt of ast.program.body) {
		if (stmt === componentNode) continue;
		// a Svelte component has no default export
		if (t.isExportDefaultDeclaration(stmt)) continue;
		// drop React imports
		if (t.isImportDeclaration(stmt)) {
			const src = stmt.source.value;
			if (src === 'react' || src === 'react-dom' || src.startsWith('react/') || src.startsWith('react-dom/')) continue;
			out.push(gen(stmt));
			continue;
		}
		out.push(gen(stmt));
	}
	return out;
}

// --- misc ---------------------------------------------------------------------

function cap(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

const KNOWN_HOOKS = new Set(['useState', 'useEffect', 'useMemo', 'useRef', 'useCallback', 'useReducer', 'useContext']);

/** Name of an unrecognized `useXxx()` in a statement, else null. */
function unknownHook(stmt: t.Statement): string | null {
	const call = t.isExpressionStatement(stmt)
		? stmt.expression
		: t.isVariableDeclaration(stmt) && stmt.declarations[0]?.init
			? stmt.declarations[0].init
			: null;
	if (call && t.isCallExpression(call) && t.isIdentifier(call.callee) && /^use[A-Z]/.test(call.callee.name) && !KNOWN_HOOKS.has(call.callee.name)) {
		return call.callee.name;
	}
	return null;
}

// React's synthetic event types → the DOM event names, since `react` is no
// longer imported. Pointer-family types have exact DOM equivalents; Change/Form/
// Input events do not, so they fall back to the generic `Event`.
const DOM_EVENTS = ['Keyboard', 'Mouse', 'Pointer', 'Focus', 'Wheel', 'Drag', 'Touch', 'Clipboard', 'Animation', 'Transition', 'Composition', 'UI'];

function cleanReactTypes(script: string, warnings: string[]): string {
	let out = script;
	for (const name of DOM_EVENTS) {
		out = out.replace(new RegExp(`React\\.${name}Event(<[^>]*>)?`, 'g'), `${name}Event`);
	}
	out = out.replace(/React\.(Change|Form|Input)Event(<[^>]*>)?/g, 'Event');
	if (/\bReact\./.test(out)) warnings.push('some React.* type references remain — map them to DOM/Svelte types by hand');
	return out;
}
function indent(text: string): string {
	return text
		.split('\n')
		.map((l) => (l.trim() ? '\t' + l : l))
		.join('\n');
}
