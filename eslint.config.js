import { registerHooks } from 'node:module';
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// TypeScript 7 (our `typescript`) ships no JavaScript compiler API, and typescript-eslint
// only parses with the TypeScript 6 API. Point typescript-eslint's `typescript` imports at
// Microsoft's side-by-side `@typescript/typescript6` package; `tsc` and editors stay on 7.
// (package.json `overrides` lets typescript-eslint's peer range accept the root TypeScript.)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === 'typescript' &&
      /[\\/]node_modules[\\/](@typescript-eslint|typescript-eslint|ts-api-utils)[\\/]/.test(
        context.parentURL ?? '',
      )
    ) {
      return nextResolve('@typescript/typescript6', { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
});
// Imported after the hook is registered (static imports would load before it).
const { default: tseslint } = await import('typescript-eslint');

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', 'openspec/', '.claude/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Destructuring to omit keys (`const { id: _, ...rest } = x`) is the codebase idiom, as tsc allows.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // Only the classic hook rules; the plugin's React Compiler rules are not enabled.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  { files: ['src/**/*.tsx'], ...jsxA11y.flatConfigs.recommended },
  {
    files: ['server/**/*.{js,mjs,ts}', '*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },
);
