// Lint for the AI service (`npm run lint`); CI fails on any error.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules", "eval/results"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: globals.node },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
