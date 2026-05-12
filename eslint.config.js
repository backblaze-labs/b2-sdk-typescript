import jsdoc from 'eslint-plugin-jsdoc'
import tsdoc from 'eslint-plugin-tsdoc'
import tseslint from 'typescript-eslint'

export default tseslint.config({
  files: ['src/**/*.ts'],
  ignores: ['src/**/*.test.ts'],
  extends: [...tseslint.configs.recommended],
  plugins: {
    jsdoc,
    tsdoc: { rules: tsdoc.rules },
  },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: true,
      tsconfigRootDir: import.meta.dirname,
    },
  },
  settings: {
    jsdoc: {
      mode: 'typescript',
    },
  },
  rules: {
    // Disable all typescript-eslint rules (Biome handles linting).
    // We only want JSDoc/TSDoc validation from ESLint.
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-empty-object-type': 'off',
    '@typescript-eslint/no-unused-expressions': 'off',
    '@typescript-eslint/no-namespace': 'off',
    '@typescript-eslint/ban-ts-comment': 'off',
    '@typescript-eslint/no-require-imports': 'off',
    '@typescript-eslint/no-empty-function': 'off',

    // ── TSDoc syntax ──────────────────────────────────────────────
    // Validates that all JSDoc tags follow TSDoc syntax rules.
    'tsdoc/syntax': 'error',

    // ── Require JSDoc on all public API surface ───────────────────
    'jsdoc/require-jsdoc': [
      'error',
      {
        publicOnly: true,
        require: {
          FunctionDeclaration: true,
          MethodDefinition: true,
          ClassDeclaration: true,
          ArrowFunctionExpression: false,
          FunctionExpression: false,
        },
        checkConstructors: true,
        checkGetters: true,
        checkSetters: true,
      },
    ],

    // ── @param validation ─────────────────────────────────────────
    // Validate that @param names match actual parameters. Do not require
    // @param for every destructured property (types are on the interface).
    'jsdoc/check-param-names': [
      'error',
      {
        checkDestructured: false,
        useDefaultObjectProperties: false,
      },
    ],
    'jsdoc/require-param-description': 'error',

    // ── @returns validation ───────────────────────────────────────
    'jsdoc/require-returns-description': 'error',
    'jsdoc/require-returns-check': 'error',

    // ── Tag validation ────────────────────────────────────────────
    'jsdoc/check-tag-names': [
      'error',
      {
        definedTags: ['internal', 'inheritDoc', 'typeParam', 'packageDocumentation'],
      },
    ],

    // TypeScript provides types; JSDoc must not duplicate them.
    'jsdoc/no-types': 'error',

    // Every JSDoc block must have a non-empty description.
    'jsdoc/require-description': [
      'error',
      {
        checkConstructors: false,
        checkGetters: false,
        checkSetters: false,
      },
    ],

    // ── Formatting / hygiene ──────────────────────────────────────
    'jsdoc/no-bad-blocks': 'error',
    'jsdoc/multiline-blocks': 'error',
    'jsdoc/empty-tags': 'error',

    // No {@link} or {@see} pointing to nonexistent symbols
    'jsdoc/check-line-alignment': 'off',

    // Tags must be in a consistent order
    'jsdoc/sort-tags': [
      'warn',
      {
        tagSequence: [
          { tags: ['module', 'packageDocumentation'] },
          { tags: ['typeParam', 'template'] },
          { tags: ['param'] },
          { tags: ['returns'] },
          { tags: ['throws'] },
          { tags: ['example'] },
          { tags: ['see'] },
          { tags: ['deprecated'] },
          { tags: ['internal'] },
        ],
      },
    ],
  },
})
