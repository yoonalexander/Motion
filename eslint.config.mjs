import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const browserOnlyImports = [
  "@/lib/pdf",
  "@/lib/pdf/*",
  "@/lib/ocr",
  "@/lib/ocr/*",
  "@/workers/*",
  "pdfjs-dist",
  "pdfjs-dist/*",
  "tesseract.js",
];

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
  ]),
  {
    files: ["app/api/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: browserOnlyImports,
              message:
                "API routes must not import browser-only PDF/OCR modules. Only approved structured JSON may cross the server boundary.",
            },
          ],
        },
      ],
    },
  },
]);
