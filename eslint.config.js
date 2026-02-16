import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  eslintPluginPrettier,
  {
    ignores: ["node_modules/", ".next/", "tsconfig.tsbuildinfo"],
  },
  {
    files: ["preload/**/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
