import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];
export default {
  poweredByHeader: false,
  outputFileTracingRoot: root,
  webpack(cfg) { cfg.resolve.alias["@"] = root; return cfg; },
  async headers() { return [{ source: "/(.*)", headers: securityHeaders }]; },
};
