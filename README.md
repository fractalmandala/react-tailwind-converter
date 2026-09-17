# react-tailwind-converter

Two **AST-based** command-line converters (no regex string-munging):

- **`tw2sass`** — Tailwind utility classes → **indented Sass**, using the *real
  Tailwind v4 compiler*. There is no hand-authored utility map: every declaration
  is exactly what Tailwind emits. Works on component files/folders, `@apply`
  stylesheets, or class lists. → **[TW2SASS.md](TW2SASS.md)**
- **`react2svelte`** — React (TSX/JSX) → **Svelte 5**, on the *Babel AST*. Hooks
  become runes, `setX(v)` becomes `x = v`, JSX becomes a Svelte template, and
  TypeScript types are preserved. → **[REACT2SVELTE.md](REACT2SVELTE.md)**

Both run in Node, take files/folders/stdin, and write to stdout or `--write`/`--out`.

---

## Install

```bash
# global — exposes the `tw2sass` and `react2svelte` commands
npm i -g react-tailwind-converter
# or: pnpm add -g react-tailwind-converter

# or run without installing
npx -p react-tailwind-converter tw2sass <paths…>
npx -p react-tailwind-converter react2svelte <paths…>

# or as a project dev dependency
npm i -D react-tailwind-converter   # then via npm scripts / npx tw2sass
```

Requires **Node 18+**. `tailwindcss@4`, `postcss`, `@babel/*`, and
`node-html-parser` are bundled as dependencies, so there's nothing else to set up.

## Usage

```bash
# Tailwind → Sass
tw2sass src/components --write        # a .sass beside each component file
tw2sass Button.svelte > button.sass   # one file → stdout
tw2sass app.css --mode apply --write  # expand @apply rules
echo 'px-4 flex hover:bg-black/50' | tw2sass - --mode classes --selector btn

# React → Svelte 5
react2svelte src/components --write   # a .svelte beside each source
react2svelte Todo.tsx > Todo.svelte   # one file → stdout
cat Widget.tsx | react2svelte -
```

Full options, modes, the complete conversion reference, worked examples,
limitations, and troubleshooting live in the two guides:

- **[TW2SASS.md](TW2SASS.md)**
- **[REACT2SVELTE.md](REACT2SVELTE.md)**

---

## What you get

**tw2sass** — Sass nested to mirror the DOM; `hover:`/`focus-visible:` → `&:hover`;
`sm:`/`md:` → `@media`; arbitrary values, opacity, `group-*`, filters, the full
palette — all resolved by Tailwind itself (colors are `oklch`, Tailwind v4's native
values). `@apply` expansion and class-list modes included.

**react2svelte** — `useState`/`useMemo`/`useEffect`/`useRef`/`useCallback`/
`useReducer`/`useContext` → runes; `value + onChange` → `bind:value`; `ref` →
`bind:this`; `{cond && …}`/`ternary`/`.map` → `{#if}`/`{#each}`; `className`→`class`,
events, `{@html}`, fragments; React imports dropped, TS types kept. Unsupported
patterns (custom hooks, `<Provider>`, class components) are flagged with warnings.

---

## Develop

```bash
pnpm install
pnpm tw2sass <paths…>          # run the TS source directly via tsx
pnpm react2svelte <paths…>
pnpm typecheck                 # tsc --noEmit
pnpm build                     # tsup → dist/{tw2sass,react2svelte}.js
```

| Path | Responsibility |
| --- | --- |
| `bin/tw2sass.ts`, `bin/react2svelte.ts` | CLI entry points |
| `src/tw/` | Tailwind engine: `resolver` (real compiler), `engine` (PostCSS→Sass), `markup`, `build`, `apply` |
| `src/react/` | `convert` (hooks/setters/props/assembly), `jsx` (JSX→Svelte template) |
| `src/tailwind.ts` | Tailwind orchestration helpers |

## License

MIT
