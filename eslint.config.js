import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'apps/server/drizzle/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
  },
  {
    files: ['apps/server/**/*.ts', 'packages/**/*.ts', '*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Data access lives only in repos/ and db/. Routes, middleware and services use repository
    // interfaces so tests can run on fakes (docs/testing.md, CLAUDE.md rule 11).
    files: [
      'apps/server/src/routes/**/*.ts',
      'apps/server/src/middleware/**/*.ts',
      'apps/server/src/auth/**/*.ts',
      'apps/server/src/audit.ts',
      'apps/server/src/app.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'better-sqlite3'],
              message: 'Use a repository (src/repos), not the database library.',
            },
            {
              group: ['**/db/schema*', '**/db/index*'],
              message: 'Use a repository (src/repos), not the database layer.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,vue}', 'lilypads/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Rule 7/8: no `v-html` on user data; no string-built SQL is enforced in review + tests.
      'vue/no-v-html': 'error',
      // Vuetify's table slots are written #item.<key>.
      'vue/valid-v-slot': ['error', { allowModifiers: true }],
      'vue/multi-word-component-names': 'off',
      // Formatting belongs to Prettier.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
    },
  },
)
