import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
    { ignores: ['runtime/**', 'dist/**', 'coverage/**', '**/DRAFT.md'] },
    js.configs.recommended,
    tseslint.configs.recommended,
    prettier,
);
