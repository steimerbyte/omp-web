import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    // Global ignores: this object has no other keys, so ESLint treats it as a
    // global ignore (applies to every config object, not just this one).
    ignores: [
      "**/src-tauri/target",
      "**/src-tauri/gen",
      // Next.js build output, in every location it can appear:
      //   - `.next`            -> default dev/build dist dir
      //   - `.next-*`          -> custom OMP_WEB_DIST_DIR (e.g. .next-cal-dialog)
      //   - `src-tauri/server/.next` -> staged desktop build (bun run desktop:build)
      "**/.next",
      "**/.next/**",
      "**/.next-*",
      "**/.next-*/**",
      "**/src-tauri/server/.next",
      "**/src-tauri/server/.next/**",
    ],
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
