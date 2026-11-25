// Lint and type-aware static analysis for the web app (src, ai, api), its tests and configs.
// `npm run lint` runs it; CI fails on any error. Rules left off are listed with the reason.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "test-results", "playwright-report", "coverage"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      // Reported, not enforced: the existing effects load once on mount on purpose, and adding
      // their inline loaders as dependencies would re-run them on every render.
      "react-hooks/exhaustive-deps": "warn",
      // Promise-returning handlers in JSX (onClick={async () => …}) are how the app is written;
      // promises dropped anywhere else must be awaited, caught, or marked with `void`.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // JSON from the backend is typed once in api.ts; flagging every `any` read is noise.
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Values are API JSON (strings, numbers, money objects handled before the String() call).
      "@typescript-eslint/no-base-to-string": "off",
      // Some handlers are async only to share a signature with ones that await.
      "@typescript-eslint/require-await": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Playwright mocks build loose JSON responses and patch browser prototypes.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
);
