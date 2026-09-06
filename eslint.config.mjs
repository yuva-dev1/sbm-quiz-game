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
    // apps/* build to their own dist/ (Vite) — build output, not source.
    "apps/self-study/dist/**",
    "apps/self-paced-course/dist/**",
  ]),
  {
    // apps/self-study and apps/self-paced-course are standalone Vite + React 18
    // apps with their own package.json/toolchain, not part of the Next.js app.
    // Rules that assume Next.js, or that come from the React-19 hooks plugin,
    // don't apply to them.
    files: ["apps/self-study/**/*.{js,jsx}", "apps/self-paced-course/**/*.{js,jsx}"],
    rules: {
      "@next/next/no-img-element": "off",
      "@next/next/no-html-link-for-pages": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
