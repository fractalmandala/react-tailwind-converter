# react2svelte — React (TSX/JSX) → Svelte 5

`react2svelte` converts React function components into **Svelte 5** components. It
works on the **Babel AST**, not with regex string replacement: hooks are matched
as call expressions, setter calls are rewritten by tree transform, and JSX is
serialized from the parse tree. Code is only turned back into text at the very end
by `@babel/generator`, so nested conditionals, `.map`, fragments, and TypeScript
types survive the round-trip.

- **[The command](#the-command--where-it-lives)** · **[Overview](#overview)** ·
  **[Install](#install--prerequisites)** ·
  **[Quick start](#quick-start)** · **[What it converts](#what-it-converts)** ·
  **[Options](#options)** · **[Output](#output-behavior)** ·
  **[Transform reference](#transform-reference)** ·
  **[Worked example](#worked-example)** · **[How it works](#how-it-works)** ·
  **[Warnings](#warnings)** · **[Edge cases](#edge-cases--gotchas)** ·
  **[Limits](#limitations)** · **[Troubleshooting](#troubleshooting)** ·
  **[Extending](#extending)** · **[Source map](#source-map)**

---

## The command & where it lives

| | |
| --- | --- |
| **Command** | `react2svelte` |
| **npm package** | `react-tailwind-converter` (also ships `tw2sass`) |
| **Package source** | `/Users/amrit/fractalmandala/css-to-sass/react-tailwind-converter` |
| **CLI entry** | `bin/react2svelte.ts` → built to `dist/react2svelte.js` (the published `bin`) |
| **Engine code** | `src/react/convert.ts` + `src/react/jsx.ts` |
| **Runs on** | Node 18+ (no browser/dev server). Deps `@babel/*`, `node-html-parser` ship with the package. |

### Installed from npm

```bash
npm i -g react-tailwind-converter        # exposes `react2svelte` globally
react2svelte <paths…>

# or run without installing:
npx -p react-tailwind-converter react2svelte <paths…>

# or as a project dev dependency, then via npx from that project:
npm i -D react-tailwind-converter
npx react2svelte <paths…>
```

Run it **from wherever your files are** and pass paths (relative or absolute).
`--write` / `--out` writes at the **target** paths you pass.

```bash
cd /Users/you/some-app
react2svelte src/components --write        # writes a .svelte beside each source
```

### From the package source (development)

```bash
cd /Users/amrit/fractalmandala/css-to-sass/react-tailwind-converter
pnpm install

pnpm react2svelte <paths…>          # run the TS source via tsx
pnpm build && node dist/react2svelte.js <paths…>   # or run the built bin
```

---

## Overview

### What it does

Given a React function component (`.tsx` / `.jsx`), it produces a `.svelte` file:

- **Hooks → runes:** `useState`→`$state`, `useMemo`→`$derived`, `useEffect`→`$effect`,
  `useRef`→`$state`/`bind:this`, `useCallback`→a function, `useReducer`→`$state`+`dispatch`,
  `useContext`→`getContext`.
- **State updates → assignments:** every `setX(v)` becomes `x = v`; updater form
  `setX(prev => …)` is inlined to `x = …`.
- **JSX → Svelte template:** `className`→`class`, event props lowercased,
  `{cond && …}`→`{#if}`, `{cond ? … : …}`→`{#if}{:else}`, `arr.map(…)`→`{#each}`,
  `style={{…}}`→`style="…"`, `dangerouslySetInnerHTML`→`{@html}`, fragments unwrapped.
- **Two-way binding:** `value={x} onChange={e => setX(e.target.value)}` collapses to
  `bind:value={x}` (and `checked`→`bind:checked`).
- **TypeScript preserved:** `interface Props`, param and return types are kept.

### Why the AST (not regex)

The previous version used regex string transforms; its central feature (rewriting
`setX(…)` calls) referenced a field that didn't exist, so it silently did nothing,
and imports were dropped. Parsing to a real AST makes the transforms correct and
composable: a setter call is rewritten wherever it appears (handlers, effects,
helpers), and the JSX serializer understands structure rather than guessing with
non-greedy regexes.

---

## Install & prerequisites

- **Node.js 18+.**
- Install the package — `npm i -g react-tailwind-converter` (or run it with
  `npx -p react-tailwind-converter react2svelte …`). See
  [The command](#the-command--where-it-lives) for every install/run option,
  including running from source.
- Runs entirely in **Node** — no browser, dev server, or network. `@babel/*` and
  `node-html-parser` ship with the package.

> Examples below use the installed command `react2svelte`. From the package source,
> use `pnpm react2svelte …` (and `pnpm react2svelte -- …` if your shell eats flags).

---

## Quick start

```bash
# a folder of components → a .svelte next to each source
react2svelte src/components --write

# one file → stdout
react2svelte Todo.tsx

# one file → a specific output file
react2svelte Todo.tsx > Todo.svelte

# a folder → a separate output directory
react2svelte src/components --out build/svelte

# stdin
cat Widget.tsx | react2svelte -
```

Conversion **warnings** (things you should review) are printed to **stderr**, so
`react2svelte Todo.tsx > Todo.svelte` captures only the component.

---

## What it converts

### Component discovery

The tool finds the component to convert, in this order:

1. `export default function C() { … }` that returns JSX.
2. A `function C() {}` or `const C = (…) => …` (optionally `export`ed) that returns
   JSX.
3. `export default C` where `C` is a `const … = () => …` declared elsewhere in the
   file.

Both block bodies (`return (<…/>)`) and expression-bodied arrows (`() => <…/>`) are
supported. If no component is found, the output is a comment saying so.

### Props

The component's first parameter becomes `$props()`:

- **Destructured** (`{ title, count = 0, items }`) → `let { title, count = 0, items, children, …rest } = $props()`.
  - Defaults are preserved (`count = 0`).
  - A rest element (`…rest`) is preserved.
  - `children` is added automatically if not already present.
- **Whole-object** (`props: Props`) → `let props: Props = $props()`.
- **Type:** an explicit param annotation (`{…}: Props`) or a module-level
  `interface Props` / `type …Props` is used to annotate `$props()`. The interface
  itself is kept in the script.

### Hooks

| Hook | Handled | Result |
| --- | --- | --- |
| `useState` | ✅ | `$state`, setter → assignment |
| `useMemo` | ✅ | `$derived` (expression) / `$derived.by` (block) |
| `useEffect` | ✅ | `$effect` (dependency array dropped) |
| `useRef` | ✅ | `$state`; DOM refs → `bind:this` + `.current` stripped |
| `useCallback` | ✅ | a `function` declaration (types preserved) |
| `useReducer` | ✅ | `$state` + a `dispatch` function |
| `useContext` | ✅ | `getContext(Ctx)` (+ import); a warning about `<Provider>` |
| `useLayoutEffect`, `useImperativeHandle`, `useTransition`, custom `useX` | ⚠️ | left as-is, with a warning |

---

## Options

| Option | Argument | Effect |
| --- | --- | --- |
| `--write` | — | write `<file>.svelte` next to each source (extension swapped) |
| `--out` | `<dir>` | write into `<dir>`, one file per input by basename; implies `--write` |
| `--ext` | `<.svelte>` | output extension (default `.svelte`) |
| `-` | — | read from stdin |
| `-h`, `--help` | — | print usage |

- Inputs are files or folders. Folders are walked recursively; `.tsx` and `.jsx`
  files are picked up; `node_modules`, `.git`, `.svelte-kit`, `build`, `dist`,
  `target` are skipped.
- Without `--write`/`--out`, results go to **stdout**.

---

## Output behavior

- **stdout (default):** each converted component is written to stdout; warnings and
  errors go to stderr.
- **`--write`:** writes `<source-with-.svelte-extension>`; prints `wrote …` plus any
  warning summary to stderr.
- **`--out <dir>`:** writes `<dir>/<basename>.svelte` (flat, by basename).
- **Parse error in a file:** that file is reported to stderr and skipped; other
  files still convert.

Every output starts with a banner comment: `<!-- Name — converted from React by
react2svelte -->`, then `<script lang="ts">`, then the template.

---

## Transform reference

### Hooks & state

| React | Svelte 5 |
| --- | --- |
| `const [v, setV] = useState(x)` | `let v = $state(x)` |
| `setV(n)` (anywhere) | `v = n` |
| `setV(prev => f(prev))` | `v = f(v)` (param inlined; block bodies use an IIFE) |
| `const m = useMemo(() => e, deps)` | `let m = $derived(e)` |
| `const m = useMemo(() => { …return e }, deps)` | `let m = $derived.by(() => { …return e })` |
| `useEffect(() => { … }, deps)` | `$effect(() => { … })` |
| `const r = useRef(x)` (value ref) | `let r = $state(x)` |
| `const r = useRef(null)` used as `ref={r}` | `let r = $state<HTMLElement \| null>(null)` + `bind:this={r}`; `r.current` → `r` |
| `const f = useCallback((a: T) => {…}, deps)` | `function f(a: T) {…}` |
| `const [s, dispatch] = useReducer(reducer, init)` | `let s = $state(init)` + `function dispatch(a){ s = reducer(s, a) }` |
| `const c = useContext(Ctx)` | `const c = getContext(Ctx)` (+ `import { getContext } from 'svelte'`) |

### JSX → template

| React | Svelte |
| --- | --- |
| `className="…"` | `class="…"` |
| `htmlFor`, `readOnly`, `tabIndex`, `autoFocus`, `maxLength`, … | `for`, `readonly`, `tabindex`, `autofocus`, `maxlength`, … |
| `onClick`, `onKeyDown`, `onFocus`, … | `onclick`, `onkeydown`, `onfocus`, … |
| `onChange` | `oninput` |
| `value={x} onChange={e => setX(e.target.value)}` | `bind:value={x}` |
| `checked={x} onChange={e => setX(e.target.checked)}` | `bind:checked={x}` |
| `{cond && <X/>}` | `{#if cond}<X/>{/if}` |
| `{cond ? <A/> : <B/>}` | `{#if cond}<A/>{:else}<B/>{/if}` |
| `{arr.map((item, i) => <X key={item.id}/>)}` | `{#each arr as item, i (item.id)}<X/>{/each}` |
| `{expr}` | `{expr}` |
| `style={{ marginTop: 4, color: c }}` | `style="margin-top: 4px; color: {c}"` |
| `<input disabled={true} />` | `<input disabled />` |
| `<x disabled={false} />` | attribute omitted |
| `{…spread}` | `{…spread}` |
| `dangerouslySetInnerHTML={{ __html: h }}` | `{@html h}` |
| `<>…</>` | children (fragment unwrapped) |
| `<img … />` (void element) | `<img … />` self-closed |
| `<Comp … />` | `<Comp …></Comp>` |

### Types & imports

| React | Svelte |
| --- | --- |
| `interface Props { … }` / `type …Props = { … }` | kept verbatim, used to annotate `$props()` |
| param/return types on callbacks | preserved (`function f(a: T): R {}`) |
| `React.KeyboardEvent`, `React.MouseEvent`, … | `KeyboardEvent`, `MouseEvent`, … |
| `React.ChangeEvent<…>`, `React.FormEvent<…>` | `Event` |
| `import … from 'react'` / `'react-dom'` | dropped |
| other imports (child components, utils, icons) | kept |

`style` numeric values get `px` appended unless the property is unitless
(`opacity`, `z-index`, `font-weight`, `line-height`, `flex`, `order`).

---

## Worked example

Input — `TodoList.tsx` (abridged):

```tsx
import React, { useState, useMemo, useCallback } from 'react';

interface Props { title: string; }

export default function TodoList({ title }: Props) {
  const [todos, setTodos] = useState<{ id: number; done: boolean }[]>([]);
  const [text, setText] = useState('');
  const remaining = useMemo(() => todos.filter(t => !t.done).length, [todos]);

  const add = useCallback(() => {
    setTodos(prev => [...prev, { id: Date.now(), done: false }]);
    setText('');
  }, [text]);

  return (
    <div className="p-4">
      <h1 className="text-xl">{title}</h1>
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={add}>Add ({remaining})</button>
    </div>
  );
}
```

```bash
react2svelte TodoList.tsx
```

Output:

```svelte
<!-- TodoList — converted from React by react2svelte -->

<script lang="ts">
	interface Props {
	  title: string;
	}

	let { title, children }: Props = $props();

	let todos = $state([]);

	let text = $state('');

	let remaining = $derived(todos.filter(t => !t.done).length);

	function add() {
	  todos = [...todos, {
	    id: Date.now(),
	    done: false
	  }];
	  text = '';
	}
</script>

<div class="p-4">
	<h1 class="text-xl">{title}</h1>
	<input bind:value={text} />
	<button onclick={add}>Add ({remaining})</button>
</div>
```

Note: `setTodos(prev => [...prev, …])` became `todos = [...todos, …]`, `setText('')`
became `text = ''`, `useMemo` became `$derived`, `useCallback` became a `function`,
and `value + onChange` collapsed to `bind:value`.

---

## How it works

```
TSX/JSX ──[@babel/parser: plugins typescript + jsx]──▶ AST
  1. find the component (fn/arrow returning JSX)
  2. scan for useState → build a { setter → state } map
  3. traverse the whole file: replace every setX(v) CallExpression with x = v
        (updater `prev => …` is inlined by substituting the param with the state)
  4. walk the component body in source order:
        hooks → runes, everything else kept, the returned JSX set aside
  5. serialize the JSX AST → Svelte template
        (control flow → {#if}/{#each}, className→class, events, bind:value,
         ref→bind:this, style object→string, {@html}, fragments)
  6. assemble <script>: svelte imports, kept module decls (minus react),
        $props(), the transformed body; then clean React.* event types and
        rewrite DOM ref `.current` reads
```

Each file is converted independently (unlike `tw2sass`, there is no cross-file
batch step).

---

## Warnings

Printed to **stderr**; the output still writes. Review these:

- `useContext → getContext(Ctx); make sure a parent runs setContext(Ctx, …)` — the
  consumer is converted but React's `<Provider>` is not; add `setContext` yourself.
- `unrecognized hook "useX" left as-is — convert or inline it manually` — a custom
  or unsupported hook remains in the script; it won't work until you port it.
- `some React.* type references remain — map them to DOM/Svelte types by hand` — a
  `React.*` type other than the auto-mapped events is still present.

---

## Edge cases & gotchas

- **Value refs vs DOM refs.** A `useRef` used as `ref={x}` is treated as a DOM ref
  (`bind:this`, `.current` stripped, typed `HTMLElement | null`). Any other `useRef`
  becomes a plain `$state`; if you used `.current` on it, that becomes a direct read
  — check the semantics (React value refs don't trigger re-render; Svelte `$state`
  is reactive).
- **`onChange` → `oninput`.** React's `onChange` fires on every input; Svelte's
  equivalent is `oninput`. For `<select>`/checkbox semantics, verify the event.
- **`bind:value` only for the assignment pattern.** `value={x}` plus a handler that
  does anything other than assign `x = e.target.value` is left as an explicit
  handler (correct, just not two-way bound).
- **Formatting.** Inline text and interpolations are kept together on one line
  (`Add ({remaining})`, `{a} / {b}`), and elements with only short inline content
  render on a single line. Block children (`{#if}`, `{#each}`, nested elements) and
  multi-line script expressions (object literals in a handler body) are pretty-
  printed across lines. All of this is whitespace-only and renders identically.
- **`React.ReactNode` / `React.FC` / `React.CSSProperties`** are *not* remapped (only
  events are), because there's no always-correct Svelte equivalent — adjust by hand
  (often `ReactNode` for children ≈ `Snippet`).

---

## Limitations

- **Class components** and `forwardRef` are not transformed.
- **`<Context.Provider>`** is not converted (only the `useContext` consumer is).
- **Custom hooks** can't be mechanized (a `useX()` can do anything); they're flagged
  and left in place.
- **Non-event `React.*` types** are left verbatim (and flagged).
- **`value`/`onChange` → `bind:` covers the common assignment case**, not numeric
  coercion (`+e.target.value`) or custom parsing.
- Intentionally a standalone CLI — **not** wired into the browser app (the app keeps
  its own separate React tab on the older converter).

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| output is `<!-- no React component … -->` | no function returning JSX was found; ensure the file exports/declares one |
| `ERROR <file>: …` on stderr | the file failed to parse as TSX; fix the syntax (or it may use a Babel plugin not enabled — only `typescript` + `jsx` are on) |
| `React.` still in the output | a non-event `React.*` type; map it to a DOM/Svelte type by hand (see warnings) |
| a hook didn't convert | it's outside the supported set (see the hooks table) — you'll have a warning |
| props missing / wrong | destructuring or a Props type the discovery didn't recognize; check the first-param shape |
| flags ignored via pnpm | use `pnpm react2svelte -- <flags>` |

---

## Extending

- **Support another hook:** add a case in `matchHook` and the emit `switch` in
  [`src/react/convert.ts`](src/react/convert.ts).
- **Add a JSX transform** (new control-flow shape, attribute rule): the serializer
  is [`src/react/jsx.ts`](src/react/jsx.ts) (`attributes`, `expressionChild`,
  `detectBind`).
- **Map more attribute spellings:** `ATTR_MAP` in `jsx.ts`.
- **Map more types** (e.g. `React.ReactNode`→`Snippet`): `cleanReactTypes` in
  `convert.ts`.
- **Recognize more component shapes:** `findComponent` in `convert.ts`.

---

## Source map

| File | Responsibility |
| --- | --- |
| [`bin/react2svelte.ts`](bin/react2svelte.ts) | CLI: arg parsing, file discovery, output |
| [`src/react/convert.ts`](src/react/convert.ts) | parse, component discovery, hook & setter transforms, props, type/import cleanup, script assembly |
| [`src/react/jsx.ts`](src/react/jsx.ts) | JSX AST → Svelte template (control flow, attributes, `bind:`, `{@html}`, fragments) |

See also **[TW2SASS.md](TW2SASS.md)** for the companion Tailwind→Sass CLI.
