# src/languages

Everything language-specific lives here. The rest of Attentry only talks to `LanguageSupport`.

## Adding a language (e.g. Go, Java, Astro)

1. Add its tree-sitter grammar package (it must ship a `.wasm` file).
2. Write `src/languages/<name>.ts` exporting a `LanguageSupport` (see `types.ts`):
   - `grammars`: file extensions and the `.wasm` to parse them with
   - `extractFunctions`: named functions, with how each gets called
   - `extractImports`: what each file imports
   - `importedModules`: which file names an import can point at
     (Astro/Vue/Svelte: strip `.astro`/`.vue`/`.svelte`, or every component looks unused)
   - `entryKind`: files that run on their own
3. Add it to the list in `index.ts`, and its id to `LanguageId` in `types.ts`.
4. Remove its extension from `UNSUPPORTED_CODE` in `src/index/files.ts`.
5. Add fixtures from a real repo: what must be flagged, and what must not.
