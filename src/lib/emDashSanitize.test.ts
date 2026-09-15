/**
 * stripEmDashes: em-dashes are banned from all user-facing AI output
 * (Forge suggestion cards, AutoForge payloads/reasons, refined messages,
 * briefings). These tests lock the replacement contract.
 */
import { stripEmDashes } from "./textSanitize";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`, extra ?? ""); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, { actual, expected });
}

console.log("stripEmDashes");
eq("spaced em-dash -> hyphen", stripEmDashes("wait — what"), "wait - what");
eq("tight em-dash -> hyphen", stripEmDashes("wait—what"), "wait-what");
eq("multiple em-dashes", stripEmDashes("a — b — c"), "a - b - c");
eq("no em-dash unchanged", stripEmDashes("lmao nice play"), "lmao nice play");
eq("regular hyphens untouched", stripEmDashes("well-known co-op"), "well-known co-op");
eq("empty string", stripEmDashes(""), "");
eq("only em-dash", stripEmDashes("—"), "-");
eq("em-dash at start", stripEmDashes("— incoming"), "- incoming");
eq("em-dash at end", stripEmDashes("incoming —"), "incoming -");
eq("double space collapse-free", stripEmDashes("a  —  b"), "a  -  b");
eq("non-string passthrough (undefined)", stripEmDashes(undefined as any), undefined);
eq("non-string passthrough (null)", stripEmDashes(null as any), null);
eq("unicode-safe around emotes", stripEmDashes("monkaS — POGGIES"), "monkaS - POGGIES");
eq("en-dash is NOT em-dash", stripEmDashes("a – b"), "a – b");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
