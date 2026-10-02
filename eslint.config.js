import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  eslintPluginPrettier,
  {
    files: ["web/src/**/*.tsx", "web/src/**/*.ts"],
    ...reactHooks.configs.flat.recommended,
  },
  {
    ignores: ["node_modules/", "web/dist/", "tsconfig.tsbuildinfo"],
  },
  {
    files: ["preload/**/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
