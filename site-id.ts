import { createHash } from "node:crypto";

// UUIDv5(URL namespace, "https://github.com/RaulSimpetru/synology-site-hub"). Keep this namespace stable.
const SITE_NAMESPACE = Buffer.from("942dca826d4a52f39b91a2f1e00c1937", "hex");

export function siteId(project: string, branch: string) {
  // Use the full identity so case, punctuation and long names remain distinct.
  const bytes = createHash("sha1").update(SITE_NAMESPACE).update(JSON.stringify([project, branch])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
