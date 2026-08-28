import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // apps/self-study builds to its own dist/ (Vite) — build output, not source.
    "apps/self-study/dist/**",
  ]),
  {
    // apps/self-study is a standalone Vite + React 18 app with its own
    // package.json/toolchain, not part of the Next.js app. Rules that assume
    // Next.js, or that come from the React-19 hooks plugin, don't apply to it.
    files: ["apps/self-study/**/*.{js,jsx}"],
    rules: {
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
