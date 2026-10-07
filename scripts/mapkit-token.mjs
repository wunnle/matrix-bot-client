#!/usr/bin/env node
// Mint a MapKit JS token locally, to try the location picker before
// /api/mapkit-token is deployed with its env. Prints the token; put it in
// .env.local as VITE_MAPKIT_TOKEN and rebuild. Lives a day by default.
//
//   node scripts/mapkit-token.mjs <path/to/AuthKey_XXXX.p8> <KEY_ID> [TEAM_ID] [hours]
//
// The key file is read here only; nothing is written or sent anywhere.
import { readFileSync } from "node:fs";
import process from "node:process";

const [keyPath, keyId, teamId = "92P3G6TJP3", hours = "24"] = process.argv.slice(2);
if (!keyPath || !keyId) {
  console.error("usage: node scripts/mapkit-token.mjs <AuthKey.p8> <KEY_ID> [TEAM_ID] [hours]");
  process.exit(1);
}

process.env.MAPKIT_KEY_ID = keyId;
process.env.MAPKIT_TEAM_ID = teamId;
process.env.MAPKIT_PRIVATE_KEY = readFileSync(keyPath, "utf8");
const { mapkitToken } = await import("../api/mapkit-token.js");
console.log(mapkitToken(Number(hours) * 3600));
