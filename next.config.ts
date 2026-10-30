import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let ompVersion = "unknown";
try {
  const ompPkgPath = join(__dirname, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
  ompVersion = (JSON.parse(readFileSync(ompPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

/**
 * The omp SDK is published as TypeScript sources and imports `bun:` builtins,
 * so webpack must never try to parse it: every `@oh-my-pi/*` request stays a
 * runtime import that Bun resolves itself.
 *
 * `serverExternalPackages` alone is not enough — it leaves the SDK's own
 * transitive entry points (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog/...`)
 * inside the bundle — so the rule below is applied unconditionally to the
 * whole scope.
 */
const OMP_SDK_REQUEST = /^@oh-my-pi\//;

const nextConfig: NextConfig = {
  // Desktop builds (scripts/stage-desktop.mjs) redirect the production build
  // into src-tauri/server/.next so packaging never touches the dev `.next/`.
  distDir: process.env.OMP_WEB_DIST_DIR || ".next",
  outputFileTracingRoot: __dirname,
  serverExternalPackages: [
    "undici",
    "@oh-my-pi/pi-coding-agent",
    "@oh-my-pi/pi-agent-core",
    "@oh-my-pi/pi-ai",
    "@oh-my-pi/pi-catalog",
    "@oh-my-pi/pi-tui",
    "@oh-my-pi/pi-utils",
  ],

  experimental: {
    /**
     * Ceiling for every request body `proxy.ts` matches (`/api/:path*`).
     *
     * This is **not** a rejection limit. Next clones the body for the proxy and
     * ends the clone silently once `bytesRead > proxyClientMaxBodySize`
     * (`node_modules/next/dist/server/body-streams.js`, `cloneBodyStream`),
     * pushing `null` into both streams; the route handler then reads a body
     * that ends in the middle of a part. Measured on this build (production,
     * 32 MB configured): a raw 40 MB POST arrived as 33 391 238 of 41 943 040
     * bytes, and a 40 MB multipart upload failed as
     * `FormData parse error missing final boundary` — an HTTP 500, not a 413.
     *
     * So the only layer that can reject with a real status is the route, and
     * this value has to sit strictly above the largest limit a route enforces
     * itself. That is the upload route: `MAX_UPLOAD_REQUEST_BYTES` (101 MB) in
     * `lib/file-upload.ts`, which answers 413 on its own. 104 MB leaves 3 MB
     * of headroom above it, so a body the upload route accepts can never be
     * truncated by construction.
     *
     * Two lower bounds also apply: the base64 expansion of
     * `MAX_ATTACHED_IMAGES_TOTAL_BYTES` (a chat prompt carries its images
     * inline, 4/3 inflation, `lib/image-attachments.ts`) and the 30 MB prompt
     * ceiling of `app/api/agent/[id]/route.ts`. Both are far below 104 MB.
     *
     * Keep in sync with `MAX_UPLOAD_REQUEST_BYTES`; `lib/file-upload.test.mjs`
     * asserts this value exceeds it, and `lib/image-attachments.test.mjs`
     * asserts the image budget still fits.
     */
    proxyClientMaxBodySize: "104mb",
  },
  webpack: (config, { isServer, nextRuntime }) => {
    if (!isServer || nextRuntime === "edge") {
      // instrumentation.ts has a Node-only dynamic import guarded by
      // NEXT_RUNTIME. Webpack still traces it for the browser fallback unless
      // the server-only module is explicitly excluded.
      config.resolve.alias["@/lib/http-dispatcher"] = false;
      return config;
    }
    const externals = Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean);
    config.externals = [
      ({ request }: { request?: string }, callback: (error?: unknown, result?: string) => void) => {
        // `import`, not `commonjs`: the SDK's package exports declare only an
        // `import` condition, so a `require()` of it cannot resolve at all.
        if (request && OMP_SDK_REQUEST.test(request)) return callback(undefined, `import ${request}`);
        return callback();
      },
      ...externals,
    ];
    return config;
  },
  // Allow the dev server to be reached over the loopback interface (the
  // browser tab connects to http://127.0.0.1:30141) and from LAN devices.
  allowedDevOrigins: ["127.0.0.1", "192.168.*.*"],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_OMP_VERSION: ompVersion,
  },
};

export default nextConfig;
