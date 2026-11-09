// Unit tests never touch the network for link checks: every cited link is treated as verified
// unless a test overrides deps.checkLinks. tests/linkcheck.test.ts covers the real checker.
import { beforeEach } from "vitest";
import { deps } from "@/lib/escrow";
import { extractLinks } from "@/lib/linkcheck";
beforeEach(() => {
  deps.checkLinks = async (url, notes) => extractLinks(url, notes).map((u) => ({ url: u, ok: true, reason: "stub", status: 200, contentType: "text/html", title: "stub" }));
});
