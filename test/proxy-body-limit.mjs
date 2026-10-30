import { readFileSync } from "node:fs";

/**
 * `experimental.proxyClientMaxBodySize` from `next.config.ts`, in bytes.
 *
 * The Next config loader cannot be trusted to resolve `lib/` imports, so the
 * value is read from the source text here instead of imported. Shared because
 * two things assert against it from different directions: the image budget is a
 * *lower* bound (its base64 expansion must fit) and the upload route's request
 * limit is an *upper* bound (the route's own 413 has to fire first).
 */
export function readConfiguredProxyBodyLimit() {
  const config = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");
  const declared = config.match(/proxyClientMaxBodySize:\s*["']?(\d+)["']?\s*(kb|mb|gb)?["']?/i);
  if (!declared) throw new Error("next.config.ts must declare experimental.proxyClientMaxBodySize");

  const unit = (declared[2] ?? "b").toLowerCase();
  const multiplier = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 ** 3 }[unit];
  if (!multiplier) throw new Error(`unreadable size unit in proxyClientMaxBodySize: ${declared[2]}`);
  return Number(declared[1]) * multiplier;
}
