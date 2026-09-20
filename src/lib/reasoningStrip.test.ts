/**
 * stripReasoningBlocks: thinking-capable vision/text models (Ollama reasoning
 * models, OpenRouter reasoning variants) can leak <think> chain-of-thought
 * into visible output — including the Visual Snapshot History description,
 * where it reads as meaningless internal deliberation instead of analysis.
 * These tests lock the stripping contract.
 */
import { stripReasoningBlocks } from "./textSanitize";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`, extra ?? ""); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, { actual, expected });
}

console.log("stripReasoningBlocks");
eq(
  "closed think block stripped",
  stripReasoningBlocks("<think>let me look at this frame</think>SCENE: gameplay"),
  "SCENE: gameplay",
);
eq(
  "think block mid-text stripped",
  stripReasoningBlocks("SCENE: raid <think>hmm what else</think>\nACTION: pushing"),
  "SCENE: raid \nACTION: pushing",
);
eq(
  "unterminated think block stripped to end",
  stripReasoningBlocks("SCENE: menu\n<think>the user wants me to describe…"),
  "SCENE: menu",
);
eq(
  "think-only output yields empty string",
  stripReasoningBlocks("<think>reasoning forever</think>"),
  "",
);
eq(
  "multiple blocks stripped",
  stripReasoningBlocks("<think>a</think>SCENE: x<think>b</think>"),
  "SCENE: x",
);
eq(
  "case-insensitive tags",
  stripReasoningBlocks("<THINK>deliberation</THINK>SCENE: y"),
  "SCENE: y",
);
eq(
  "stray closing tag removed",
  stripReasoningBlocks("SCENE: z</think>"),
  "SCENE: z",
);
eq(
  "thinking/reasoning variants stripped",
  stripReasoningBlocks("<thinking>a</thinking><reasoning>b</reasoning>SCENE: q"),
  "SCENE: q",
);
eq(
  "structured vision output untouched",
  stripReasoningBlocks("SCENE: game\nACTION: boss fight\nENERGY: hyped"),
  "SCENE: game\nACTION: boss fight\nENERGY: hyped",
);
eq("plain text untouched", stripReasoningBlocks("Captured — no analysis"), "Captured — no analysis");
eq("empty string", stripReasoningBlocks(""), "");
eq("non-string passthrough (undefined)", stripReasoningBlocks(undefined as any), undefined);
eq("non-string passthrough (null)", stripReasoningBlocks(null as any), null);
eq(
  "excess blank lines collapsed after strip",
  stripReasoningBlocks("<think>a</think>\n\n\n\nSCENE: end"),
  "SCENE: end",
);
eq(
  "text before unterminated block preserved",
  stripReasoningBlocks("SCENE: lobby\nACTION: waiting<think>partial"),
  "SCENE: lobby\nACTION: waiting",
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
