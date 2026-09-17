# tw2sass — Tailwind → indented Sass

`tw2sass` converts Tailwind utility classes into **indented Sass** (`.sass`
syntax: no braces, no semicolons). It drives the **real Tailwind v4 compiler** —
there is no hand-authored utility lookup table anywhere in this tool, so every
declaration it emits is exactly what Tailwind itself would generate, including
arbitrary values, modifiers, and anything Tailwind adds in future releases.

- **[The command](#the-command--where-it-lives)** · **[Overview](#overview)** ·
  **[Install](#install--prerequisites)** ·
  **[Quick start](#quick-start)** · **[Inputs & modes](#inputs--modes)** ·
  **[Options](#options)** · **[Output](#output-behavior)** ·
  **[Conversion reference](#conversion-reference)** ·
  **[Worked example](#worked-example)** · **[How it works](#how-it-works)** ·
  **[Edge cases](#edge-cases--gotchas)** · **[Limits](#limitations)** ·
  **[Troubleshooting](#troubleshooting)** · **[Extending](#extending)** ·
  **[Source map](#source-map)**

---

## The command & where it lives

| | |
| --- | --- |
| **Command** | `tw2sass` |
| **npm package** | `react-tailwind-converter` (also ships `react2svelte`) |
| **Package source** | `/Users/amrit/fractalmandala/css-to-sass/react-tailwind-converter` |
| **CLI entry** | `bin/tw2sass.ts` → built to `dist/tw2sass.js` (the published `bin`) |
| **Engine code** | `src/tw/*.ts` + `src/tailwind.ts` |
| **Runs on** | Node 18+ (no browser/dev server). Deps `tailwindcss`, `postcss`, `node-html-parser` ship with the package. |

### Installed from npm

```bash
npm i -g react-tailwind-converter      # exposes `tw2sass` globally
tw2sass <paths…>

# or run without installing:
npx -p react-tailwind-converter tw2sass <paths…>

# or as a project dev dependency, then via npx from that project:
npm i -D react-tailwind-converter
npx tw2sass <paths…>
```

Because it's a normal CLI, you run it **from wherever your files are** and pass
paths (relative or absolute) — no need to be inside any particular repo.

```bash
cd /Users/you/some-app
tw2sass src/components --write          # writes a .sass beside each file
```

### From the package source (development)

```bash
cd /Users/amrit/fractalmandala/css-to-sass/react-tailwind-converter
pnpm install

pnpm tw2sass <paths…>          # run the TS source via tsx
pnpm build && node dist/tw2sass.js <paths…>   # or run the built bin
```

`--write` / `--out` writes at the **target** paths you pass, not inside the package.

---

## Overview

### What it does

Point it at component files, a folder, or a stylesheet, and it emits Sass:

- **Component markup** → Sass **nested to mirror the DOM**. Each element becomes a
  selector; its children nest inside it; `hover:` / `focus-visible:` become
  `&:hover` / `&:focus-visible`; `sm:` / `md:` / `lg:` become `@media` blocks.
- **`@apply` stylesheets** → each rule's `@apply` utilities are expanded into real
  declarations, keeping the rule's own declarations.
- **Class-list files** → one Sass block for a bag of class tokens.

### Why the real compiler (not a lookup map)

The previous version of this tool hand-maintained an ~900-line `if`-chain mapping
utilities to CSS. That approach drifts from Tailwind and had ordering bugs (e.g.
`border-teal-500` matched the `border-t*` width rule and became
`border-top-width`). `tw2sass` instead hands the exact class list to Tailwind's
own `compile().build()` and reads back the CSS it produces, so the mapping is
correct *by construction* and covers the entire utility surface: arbitrary values
(`w-[250px]`, `bg-[#100e0b]`), opacity (`bg-black/50`), responsive/state variants,
`group-*`, filters, transforms, the full palette, and so on.

### Values are raw CSS

Output uses **raw resolved values**, not tokens. Tailwind's theme variables are
inlined: `p-4` → `padding: calc(0.25rem * 4)`, `bg-zinc-900` →
`background-color: oklch(21% 0.006 285.885)`. Colors are **`oklch(…)`** because
that is Tailwind v4's native palette representation.

---

## Install & prerequisites

- **Node.js 18+.**
- Install the package — `npm i -g react-tailwind-converter` (or run it with
  `npx -p react-tailwind-converter tw2sass …`). See
  [The command](#the-command--where-it-lives) for every install/run option,
  including running from source.
- Runs entirely in **Node** — no browser, dev server, or network. `tailwindcss`,
  `postcss`, and `node-html-parser` ship with the package.

> Examples below use the installed command `tw2sass`. If you run from the package
> source instead, use `pnpm tw2sass …` (and `pnpm tw2sass -- …` if your shell eats
> the flags).

---

## Quick start

```bash
# a whole folder of components → a .sass next to each source file
tw2sass src/lib/components --write

# one file → stdout
tw2sass Button.svelte

# one file → a specific output file
tw2sass Button.svelte > button.sass

# a folder → a separate output directory
tw2sass src/lib/components --out build/styles

# expand @apply in a stylesheet
tw2sass src/app.css --mode apply --write

# a bag of classes from stdin, under a chosen selector name
echo 'px-4 py-2 flex items-center gap-2 hover:bg-black/50' \
  | tw2sass - --mode classes --selector button
```

---

## Inputs & modes

Each input file is processed in one **mode**. The mode is auto-detected from the
file extension and contents, or forced with `--mode`.

| Mode | Auto-detected for | What it reads | What it emits |
| --- | --- | --- | --- |
| `component` | `.svelte .html .htm .jsx .tsx .vue .astro` | every `class="…"` / `className="…"` on every element | Sass nested to mirror the DOM |
| `apply` | `.css` / `.scss` **containing `@apply`** | each rule's `@apply` utilities + its own declarations | one Sass block per rule |
| `classes` | `.txt`, or `.css`/`.scss` with **no `@apply`** | whitespace/newline-separated class tokens | one Sass block under a selector |

**Inputs may be files or folders.** Folders are walked recursively; these are
skipped: `node_modules`, `.git`, `.svelte-kit`, `build`, `dist`, `target`. Only
files with a recognized extension (the markup set, `.css`, `.scss`, `.sass`,
`.txt`) are picked up.

**stdin:** pass `-` as a path to read from stdin. Combine with `--mode` (defaults
to `component` for stdin), and `--selector` for classes mode.

### Component mode details

- Reads both `class="…"` (HTML/Svelte/Vue/Astro) and `className="…"` (JSX/TSX).
- **Dynamic class values** are handled gracefully: any `{…}` expression segment is
  stripped and only the static class tokens are used. So
  `class="px-4 {active ? 'ring-2' : ''}"` contributes `px-4` (the `ring-2` inside
  the expression is not statically known and is skipped).
- Svelte's `class:foo` directive is a different attribute and is ignored.
- **Selector naming:** an element's Sass selector is its first **non-utility**
  class (a class Tailwind produced no rule for — i.e. one of your own semantic
  names). If it has none, a class is synthesized from the tag name (`.div`,
  `.button`), deduped among siblings (`.div-2`, `.div-3`).
- An element with no styles of its own but with styled descendants is still
  emitted as a wrapper, so nesting structure is preserved. An element with no
  styles and no styled descendants is omitted.
- Multiple root elements produce multiple top-level Sass blocks.

### apply mode details

- Only `.css`/`.scss` inputs. Each top-level rule that contains `@apply a b c` is
  emitted as a Sass block: the applied utilities become declarations, followed by
  the rule's own literal declarations (which win on conflict, matching `@apply`
  semantics), followed by any state/responsive variants of the applied classes as
  nested blocks.
- `@apply` with a trailing `!` (e.g. `@apply px-4!`) is accepted; the `!` is
  ignored for resolution.

### classes mode details

- Treats the whole file (or stdin) as a bag of class tokens.
- Emits a single block. The selector is `--selector <name>` if given, otherwise the
  file's basename without extension (a leading `.` is stripped). For stdin with no
  `--selector`, the selector is `stdin` — pass `--selector` to name it.
- This mode is **not** a general CSS→Sass converter. A full CSS file (with real
  rules and `{}`) fed as `classes` will not produce meaningful output; use it only
  for a list of Tailwind class tokens.

---

## Options

| Option | Argument | Effect |
| --- | --- | --- |
| `--write` | — | write `<file>.sass` next to each source file (extension swapped) |
| `--out` | `<dir>` | write results into `<dir>`, one file per input named by basename; implies `--write` |
| `--mode` | `auto` \| `component` \| `apply` \| `classes` | force the mode for every input (default `auto`, per-file) |
| `--selector` | `<name>` | selector name for `classes` mode (default: file stem). A leading `.` is stripped. |
| `--ext` | `<.sass>` | output file extension (default `.sass`); a leading `.` is added if missing |
| `-` | — | read from stdin instead of a path |
| `-h`, `--help` | — | print usage |

Notes:

- `--write` alone writes beside the source (`Card.svelte` → `Card.sass`).
- `--out <dir>` writes into that dir **flat, by basename**, so two inputs with the
  same basename in different folders would collide — use `--write` (beside source)
  if you need to preserve paths.
- Without `--write`/`--out`, all results go to **stdout**, each prefixed with a
  `// <relative path>` header so multiple files are distinguishable.

---

## Output behavior

- **stdout (default):** every input's Sass is concatenated, each preceded by a
  `// path` comment. Progress/skip/error notes go to **stderr**, so
  `tw2sass … > out.sass` captures only Sass.
- **`--write`:** writes `<source-with-.sass-extension>`; prints one `wrote …` line
  per file to stderr, plus a note when an element kept a non-utility class as its
  selector.
- **`--out <dir>`:** writes `<dir>/<basename>.sass`; creates the directory.
- **Empty input:** a file with no classes prints `(skipped, no classes)` to stderr
  and produces no output for that file.
- **`@keyframes`:** when a utility needs keyframes (`animate-spin`, `animate-pulse`,
  …), they are collected **once** (deduped across all inputs) and emitted:
  - to **stdout** as a trailing `// @keyframes` block, or
  - to `<out>/_keyframes.sass` when `--out` is used.
  - With `--write` beside-source (no `--out`), keyframes are **not written** —
    there is no single home for them; use `--out` if your components use
    `animate-*` and you need the keyframes emitted to a file.

---

## Conversion reference

### Variants → nesting

| Tailwind on an element | Sass |
| --- | --- |
| base utilities (`flex`, `p-4`) | declarations directly on the element's selector |
| `hover:`, `focus:`, `focus-visible:`, `active:`, `disabled:` | `&:hover`, `&:focus`, `&:focus-visible`, `&:active`, `&:disabled` |
| `sm:` `md:` `lg:` `xl:` `2xl:` | `@media (width >= …)` blocks (Tailwind v4 range syntax) |
| `group-hover:` etc. | nested `&:is(:where(.group):hover *)` (Tailwind's own selector) |
| `dark:` | `@media (prefers-color-scheme: dark)` block |
| nested DOM elements | nested selectors, mirroring the tree |

### Values

| Kind | Example in → out |
| --- | --- |
| spacing | `p-4` → `padding: calc(0.25rem * 4)` |
| color | `bg-zinc-900` → `background-color: oklch(21% 0.006 285.885)` |
| arbitrary length | `w-[250px]` → `width: 250px` |
| arbitrary color | `bg-[#100e0b]` → `background-color: #100e0b` |
| color + opacity | `bg-black/50` → `background-color: color-mix(in oklab, #000 50%, transparent)` |
| radius | `rounded-full` → `border-radius: calc(infinity * 1px)` |
| composed effects | `blur-[175px]` → `filter: blur(175px)` (Tailwind's `--tw-*` plumbing is resolved and dropped) |

`calc(…)` is preserved (it is valid CSS). Colors are `oklch(…)` — Tailwind v4's
native palette; there is no automatic conversion to hex.

### Things that are cleaned up automatically

- Tailwind's runtime custom properties (`--tw-blur`, `--tw-border-style`, …) are
  resolved into the declarations that read them and then removed, so you get
  `filter: blur(175px)` and `border-style: solid` rather than raw plumbing.
- Empty `var(--tw-*,)` slots that inline to nothing are collapsed
  (`filter: blur(1px)` not `filter: blur(1px)     `).

---

## Worked example

Input — `Card.svelte`:

```svelte
<div class="relative flex flex-col gap-4 p-6 rounded-xl bg-zinc-900 border border-zinc-700 hover:border-teal-500">
  <h2 class="text-xl font-bold text-white tracking-tight">{title}</h2>
  <button class="mt-2 px-4 py-2 rounded-lg bg-teal-500 text-black font-medium hover:bg-teal-400 focus-visible:ring-2 md:px-6">
    Action
  </button>
</div>
```

```bash
tw2sass Card.svelte
```

Output:

```sass
.div
	position: relative
	display: flex
	flex-direction: column
	gap: calc(0.25rem * 4)
	padding: calc(0.25rem * 6)
	border-radius: 0.75rem
	background-color: oklch(21% 0.006 285.885)
	border-style: solid
	border-width: 1px
	border-color: oklch(37% 0.013 285.805)
	@media (hover: hover)
		&:hover
			border-color: oklch(70.4% 0.14 182.503)
	.h2
		font-size: 1.25rem
		line-height: calc(1.75 / 1.25)
		font-weight: 700
		color: #fff
		letter-spacing: -0.025em
	.button
		margin-top: calc(0.25rem * 2)
		padding-inline: calc(0.25rem * 4)
		padding-block: calc(0.25rem * 2)
		border-radius: 0.5rem
		background-color: oklch(70.4% 0.14 182.503)
		color: #000
		font-weight: 500
		&:focus-visible
			box-shadow: 0 0 #0000, 0 0 #0000, 0 0 0 calc(2px + 0px) currentcolor, 0 0 #0000
		@media (hover: hover)
			&:hover
				background-color: oklch(77.7% 0.152 181.912)
		@media (width >= 48rem)
			padding-inline: calc(0.25rem * 6)
```

The DOM nesting is preserved (`.h2` and `.button` inside `.div`), `hover:` became
`&:hover`, and `md:px-6` became a `@media (width >= 48rem)` block on `.button`.

---

## How it works

```
input files ──┬─ component: node-html-parser → element tree → collect classes
              ├─ apply:     PostCSS → @apply params → collect classes
              └─ classes:   tokenize → collect classes
                                      │
                  (all candidate classes, deduped across every input)
                                      ▼
        real Tailwind v4 compiler:  compile('@import "tailwindcss/theme.css";
                                             @import "tailwindcss/utilities.css";')
                                    .build([ …candidate classes… ])
                                      │   explicit candidates — no Oxide/content scan
                                      ▼
        PostCSS parse ─▶ class → [ { media, "&suffix", decls } … ] map
                         · theme var() inlined to raw values
                         · @property initial-values captured as defaults
                         · --tw-* plumbing resolved into consumers and dropped
                                      ▼
        per element: base decls + nested variant blocks + nested child elements
                                      ▼
        indented Sass (structure = the DOM)
```

Everything runs **once per invocation**: all classes across all input files are
resolved in a single `compile().build()` call, then each file is rendered against
the shared class map. This keeps a folder conversion fast.

---

## Edge cases & gotchas

- **Colors are `oklch`, not hex.** This is Tailwind v4's real value. There is no
  `--hex` flag (yet).
- **Selector names are guessed** from your semantic classes or the tag. Rename them
  to taste — the tool does not (yet) also rewrite your markup to use the new class
  names.
- **`@apply` files must be real CSS** the PostCSS parser accepts. Deeply nested SCSS
  rules with `@apply` are handled at the top level; unusual nesting may not be.
- **Non-utility classes are kept as selectors, not dropped.** If you feed a class
  that isn't a Tailwind utility (a typo, or a component class), it becomes (or
  contributes to) the selector name; it is reported in the write summary.
- **A plain full CSS file** is not a valid `classes` input (this tool converts
  *Tailwind classes*, not arbitrary CSS — the app's CSS→Sass mode is separate).
- **`animate-*` keyframes** need `--out` to be written to a file (see
  [Output](#output-behavior)).

---

## Limitations

- **Default theme only.** A project's custom `@theme` / config is not read, so
  custom color names, spacing, or breakpoints won't resolve. (Planned: a
  `--theme <file.css>` flag to load your theme.)
- **No `@plugin` / `@config` JS.** Tailwind plugins and JS config are not loaded.
- **No markup rewrite.** It emits Sass; it does not also produce a de-Tailwind-ed
  HTML/JSX file with the new class names.
- **No token mapping.** Output is raw values, not `var(--space-4)` etc. (by design;
  a token-mapping mode could be added).
- **Svelte-only concern:** this is a standalone CLI; it is intentionally **not**
  wired into the browser app in this repo.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `cannot resolve stylesheet "…"` | Tailwind's theme/utilities entrypoints weren't found — run `pnpm install` so `tailwindcss@4` is present. |
| `@plugin/@config JS modules are not supported` | Your input (or an `@apply` file) pulls in a Tailwind plugin/config; remove it or pre-resolve. |
| a custom class produced no output | It isn't a Tailwind utility; it's treated as a selector name. Check spelling, or that it's a real Tailwind class. |
| colors look wrong / unfamiliar | They're `oklch(…)` — Tailwind v4's real palette. Convert to hex downstream if needed. |
| `no supported files found` | The path has no files with a recognized extension, or everything was under a skipped dir (`node_modules`, `build`, …). |
| flags seem ignored via pnpm | Use `pnpm tw2sass -- <flags>`. |

---

## Extending

- **Load a custom theme:** `src/tw/resolver.ts` builds the compiler from
  `tailwindcss/theme.css` + `tailwindcss/utilities.css`. Add the project's theme
  CSS to the `SOURCE` import list (and a `loadStylesheet` entry) to resolve custom
  tokens.
- **Change value handling** (e.g. oklch→hex, or map to design tokens): the single
  choke point is `inlineVars` / `declsOf` in `src/tw/engine.ts`, where each
  declaration value is finalized.
- **Change selector naming or nesting:** `src/tw/build.ts` (`buildSassTree`).
- **Add an input file type:** `MARKUP_EXT` / `STYLE_EXT` and `modeFor` in
  `bin/tw2sass.ts`.

---

## Source map

| File | Responsibility |
| --- | --- |
| [`bin/tw2sass.ts`](bin/tw2sass.ts) | CLI: arg parsing, file discovery, mode detection, batch resolve, output |
| [`src/tw/resolver.ts`](src/tw/resolver.ts) | runs the real Tailwind v4 compiler over a candidate class list |
| [`src/tw/engine.ts`](src/tw/engine.ts) | PostCSS → class-rule map; theme-var inlining; indented-Sass emitter |
| [`src/tw/markup.ts`](src/tw/markup.ts) | markup → element tree (node-html-parser); class collection |
| [`src/tw/build.ts`](src/tw/build.ts) | element tree + class map → nested Sass tree |
| [`src/tw/apply.ts`](src/tw/apply.ts) | `@apply` expansion |
| [`src/tailwind.ts`](src/tailwind.ts) | orchestration helpers (`convertTailwind`, `renderTree`, `convertClassList`) |

See also **[REACT2SVELTE.md](REACT2SVELTE.md)** for the companion React→Svelte 5 CLI.
