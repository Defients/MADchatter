import { describeConfidenceThreshold } from "./confidenceThreshold";

const cases: Array<[number, string]> = [
  [0, "AGGRESSIVE"],
  [0.39, "AGGRESSIVE"],
  [0.4, "ACTIVE"],
  [0.59, "ACTIVE"],
  [0.6, "BALANCED"],
  [0.74, "BALANCED"],
  [0.75, "CAUTIOUS"],
  [0.89, "CAUTIOUS"],
  [0.9, "STRICT"],
  [1, "STRICT"],
];

let passed = 0;
for (const [value, expected] of cases) {
  const actual = describeConfidenceThreshold(value);
  if (actual.label !== expected || !actual.color) {
    throw new Error(`${value}: expected ${expected} with a color, got ${JSON.stringify(actual)}`);
  }
  passed++;
}

if (describeConfidenceThreshold(-1).label !== "AGGRESSIVE") throw new Error("values below zero must clamp");
if (describeConfidenceThreshold(2).label !== "STRICT") throw new Error("values above one must clamp");
if (describeConfidenceThreshold(Number.NaN).label !== "ACTIVE") throw new Error("NaN must use the safe 50% default");

console.log(`${passed + 3}/${passed + 3} confidence-threshold scenarios passed`);
