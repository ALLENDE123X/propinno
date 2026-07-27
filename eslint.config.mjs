import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import eslintPluginSecurity from "eslint-plugin-security";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  eslintPluginSecurity.configs.recommended,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // A leftover dev-agent git worktree under .claude/worktrees/ holds a full
    // stale copy of the codebase (including its own node_modules), which
    // otherwise gets scanned as if it were real source.
    ".claude/**",
  ]),
]);

export default eslintConfig;

