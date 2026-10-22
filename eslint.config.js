import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  // The bot and the Vercel functions run untyped Node, where nothing else
  // notices a name that doesn't exist: a call to a removed helper sat in the
  // bot, threw on every artifact, and was caught quietly. Just that check here;
  // `npm test` runs it (lint:node, scripts/lint-node.mjs).
  {
    files: ['scripts/**/*.{js,mjs,cjs}', 'api/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { 'no-undef': 'error' },
  },
])
