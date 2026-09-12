import type {
  AutoForgeRule,
  RuleCondition,
  RuleAction,
  RuleEngineContext,
  RuleEvaluationResult,
} from "../types";
import { useAppStore } from "../store";
import { getPlatformSendFn } from "./platformSend";
import { toast } from "sonner";
import { playSfx } from "./sfx";

// ─── Condition Evaluation ────────────────────────────────────────────────────

function evaluateCondition(condition: RuleCondition, ctx: RuleEngineContext): boolean {
  switch (condition.type) {
    case "chat_velocity_above":
      return ctx.chatVelocity > (condition.value ?? 0);
    case "chat_velocity_below":
      return ctx.chatVelocity < (condition.value ?? 0);
    case "sentiment_is":
      return ctx.sentimentLabel === condition.sentimentLabel;
    case "sentiment_is_not":
      return ctx.sentimentLabel !== condition.sentimentLabel;
    case "time_since_last_action_above":
      return ctx.timeSinceLastActionMs > (condition.value ?? 0) * 1000;
    case "time_since_last_action_below":
      return ctx.timeSinceLastActionMs < (condition.value ?? 0) * 1000;
    case "keyword_detected":
      return condition.keyword
        ? ctx.recentChatText.toLowerCase().includes(condition.keyword.toLowerCase())
        : false;
    case "keyword_not_detected":
      return condition.keyword
        ? !ctx.recentChatText.toLowerCase().includes(condition.keyword.toLowerCase())
        : true;
    case "mention_detected":
      return ctx.isMentioned;
    case "activity_spike":
      return ctx.activitySpike;
    case "stream_health_is":
      return ctx.streamHealthLabel === condition.healthLabel;
    case "hype_level_above":
      return ctx.hypeLevel > (condition.value ?? 0);
    case "hype_level_below":
      return ctx.hypeLevel < (condition.value ?? 0);
    case "unique_chatters_above":
      return ctx.uniqueChatters > (condition.value ?? 0);
    case "viewer_count_above":
      return ctx.viewerCount > (condition.value ?? 0);
    case "viewer_count_below":
      return ctx.viewerCount < (condition.value ?? 0);
    case "audio_energy_above":
      return ctx.audioEnergyRms > (condition.value ?? 0) / 100;
    case "audio_energy_below":
      return ctx.audioEnergyRms < (condition.value ?? 0) / 100;
    case "time_of_day_after": {
      const h = new Date().getHours();
      return h >= (condition.hour ?? 0);
    }
    case "time_of_day_before": {
      const h = new Date().getHours();
      return h < (condition.hour ?? 24);
    }
    case "autoforge_is_enabled":
      return ctx.autoForgeEnabled;
    case "autoforge_is_disabled":
      return !ctx.autoForgeEnabled;
    case "mood_is":
      return ctx.currentMood === condition.mood;
    case "mood_is_not":
      return ctx.currentMood !== condition.mood;
    case "consecutive_silence_above":
      return ctx.consecutiveSilence > (condition.value ?? 0);
    case "active_bot_count_above":
      return ctx.activeBotCount > (condition.value ?? 0);
    case "active_bot_count_below":
      return ctx.activeBotCount < (condition.value ?? 0);
    default:
      return false;
  }
}

function evaluateConditions(
  conditions: RuleCondition[],
  operator: "and" | "or",
  ctx: RuleEngineContext
): { passed: boolean; details: string } {
  if (conditions.length === 0) {
    return { passed: false, details: "No conditions defined" };
  }
  const results = conditions.map((c) => evaluateCondition(c, ctx));
  if (operator === "and") {
    const passed = results.every((r) => r);
    return {
      passed,
      details: passed
        ? "All conditions met"
        : `${results.filter((r) => !r).length}/${conditions.length} conditions not met`,
    };
  } else {
    const passed = results.some((r) => r);
    return {
      passed,
      details: passed
        ? `${results.filter((r) => r).length}/${conditions.length} conditions met`
        : "No conditions met",
    };
  }
}

// ─── Action Execution ────────────────────────────────────────────────────────

async function executeAction(action: RuleAction, botId?: string): Promise<boolean> {
  const state = useAppStore.getState();
  const channel = state.streamMetadata?.channelName;

  switch (action.type) {
    case "send_message":
    case "send_emote": {
      if (!channel || !action.payload) {
        toast.error(`Rule action failed: no channel or payload`);
        return false;
      }
      // In multi-bot mode, send through the specified bot's identity.
      // When botId is omitted (legacy single-bot mode), uses the singleton.
      const sendFn = getPlatformSendFn(state.platform, botId);
      try {
        await sendFn(channel, action.payload);
        return true;
      } catch (e: any) {
        toast.error(`Rule send failed: ${e.message || e}`);
        return false;
      }
    }

    case "change_mood": {
      if (action.mood) {
        state.setMoodLock(true, action.mood);
        toast.info(`Rule: mood locked to "${action.mood}"`);
        return true;
      }
      return false;
    }

    case "apply_template": {
      if (action.templateId) {
        const template = state.forgeTemplates.find((t) => t.id === action.templateId);
        if (template) {
          state.applyForgeTemplate(action.templateId);
          toast.info(`Rule: applied template "${template.name}"`);
          return true;
        }
        toast.error(`Rule: template not found`);
        return false;
      }
      return false;
    }

    case "trigger_full_forge": {
      window.dispatchEvent(new CustomEvent("forge-trigger"));
      toast.info("Rule: triggered Full Forge");
      return true;
    }

    case "notify_user": {
      const msg = action.notification || action.payload || "Rule triggered";
      toast.warning(`Rule Notification`, { description: msg, duration: 6000 });
      playSfx("mention_alert");
      return true;
    }

    case "set_hype_level": {
      if (action.hypeLevel !== undefined) {
        state.setHypeLevel(action.hypeLevel);
        return true;
      }
      return false;
    }

    case "force_autoforge_check": {
      // In multi-bot mode, target the bot whose tick fired the rule so
      // only that bot checks (not every bot). In legacy mode, broadcast.
      if (botId) {
        window.dispatchEvent(new CustomEvent("autoforge-force-check", { detail: { botId } }));
        toast.info(`Rule: forced AutoForge check (bot)`);
      } else {
        window.dispatchEvent(new CustomEvent("autoforge-force-check"));
        toast.info("Rule: forced AutoForge check");
      }
      return true;
    }

    case "toggle_autoforge": {
      const enable = action.enabled ?? true;
      state.setAutoForgeEnabled(enable);
      toast.info(`Rule: AutoForge ${enable ? "enabled" : "disabled"}`, {
        duration: 4000,
      });
      return true;
    }

    case "set_confidence_threshold": {
      if (typeof action.confidenceThreshold === "number") {
        state.setAutoForgeConfidenceThreshold(action.confidenceThreshold);
        toast.info(`Rule: confidence threshold set to ${Math.round(action.confidenceThreshold * 100)}%`);
        return true;
      }
      return false;
    }

    case "clear_mood_lock": {
      state.setMoodLock(false, null);
      toast.info("Rule: mood lock cleared");
      return true;
    }

    case "set_length_preference": {
      if (action.lengthPreference) {
        state.updateConfig({ lengthPreference: action.lengthPreference });
        toast.info(`Rule: length preference set to "${action.lengthPreference}"`);
        return true;
      }
      return false;
    }

    default:
      return false;
  }
}

// ─── Rule Evaluation ─────────────────────────────────────────────────────────

export function evaluateRule(
  rule: AutoForgeRule,
  ctx: RuleEngineContext
): { shouldFire: boolean; reason: string } {
  if (!rule.enabled) {
    return { shouldFire: false, reason: "Rule is disabled" };
  }

  // Check fire limit
  if (rule.maxFires > 0 && rule.fireCount >= rule.maxFires) {
    return { shouldFire: false, reason: "Fire limit reached" };
  }

  // Check cooldown
  const now = Date.now();
  if (rule.lastFiredMs > 0 && now - rule.lastFiredMs < rule.cooldownMs) {
    const remaining = Math.ceil((rule.cooldownMs - (now - rule.lastFiredMs)) / 1000);
    return { shouldFire: false, reason: `Cooldown: ${remaining}s remaining` };
  }

  // Evaluate conditions
  const { passed, details } = evaluateConditions(rule.conditions, rule.conditionOperator, ctx);
  return { shouldFire: passed, reason: details };
}

export async function fireRule(
  rule: AutoForgeRule,
  ctx: RuleEngineContext,
  botId?: string
): Promise<RuleEvaluationResult> {
  const { shouldFire, reason } = evaluateRule(rule, ctx);

  if (!shouldFire) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      fired: false,
      reason,
      actionsExecuted: 0,
    };
  }

  // Mark as fired
  useAppStore.getState().updateAutoForgeRule(rule.id, {
    lastFiredMs: Date.now(),
    fireCount: rule.fireCount + 1,
  });

  // Execute actions with delays
  let actionsExecuted = 0;
  for (const action of rule.actions) {
    if (action.delayMs > 0) {
      await new Promise((r) => setTimeout(r, action.delayMs));
    }
    const success = await executeAction(action, botId);
    if (success) actionsExecuted++;
  }

  toast.success(`Rule fired: ${rule.name}`, {
    description: `${actionsExecuted}/${rule.actions.length} actions executed`,
    duration: 4000,
  });

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    fired: true,
    reason: "Fired successfully",
    actionsExecuted,
  };
}

// ─── Batch Evaluation ────────────────────────────────────────────────────────

export async function evaluateAllRules(
  rules: AutoForgeRule[],
  ctx: RuleEngineContext,
  botId?: string
): Promise<RuleEvaluationResult[]> {
  const results: RuleEvaluationResult[] = [];

  for (const rule of rules) {
    // Re-read the rule from store to get latest fireCount/lastFiredMs
    const currentRule = useAppStore.getState().autoForgeRules.find((r) => r.id === rule.id);
    if (!currentRule) continue;

    const result = await fireRule(currentRule, ctx, botId);
    results.push(result);
  }

  return results;
}

// ─── Dry Run (for UI preview) ────────────────────────────────────────────────

export function dryRunRule(
  rule: AutoForgeRule,
  ctx: RuleEngineContext
): { conditionResults: { condition: RuleCondition; passed: boolean }[]; overall: boolean } {
  const conditionResults = rule.conditions.map((c) => ({
    condition: c,
    passed: evaluateCondition(c, ctx),
  }));

  const overall =
    rule.conditionOperator === "and"
      ? conditionResults.every((r) => r.passed)
      : conditionResults.some((r) => r.passed);

  return { conditionResults, overall };
}

// ─── Preset Rules ────────────────────────────────────────────────────────────

export interface RulePreset {
  name: string;
  description: string;
  rule: Omit<AutoForgeRule, "id" | "createdAt" | "lastFiredMs" | "fireCount">;
}

export const RULE_PRESETS: RulePreset[] = [
  {
    name: "Hype Response",
    description: "When chat velocity spikes above 25/min and hype level is high, send a hype emote cascade.",
    rule: {
      name: "Hype Response",
      description: "Auto-respond to chat hype with emotes",
      enabled: true,
      conditions: [
        { id: "c1", type: "chat_velocity_above", value: 25 },
        { id: "c2", type: "hype_level_above", value: 2 },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "send_emote", payload: "PogChamp", delayMs: 0 },
        { id: "a2", type: "send_emote", payload: "KEKW", delayMs: 1200 },
      ],
      cooldownMs: 60000,
      maxFires: 0,
    },
  },
  {
    name: "Quiet Chat Reviver",
    description: "When no action for 5+ minutes and chat is slow, trigger a Full Forge to re-engage.",
    rule: {
      name: "Quiet Chat Reviver",
      description: "Re-engage when chat goes quiet",
      enabled: true,
      conditions: [
        { id: "c1", type: "time_since_last_action_above", value: 300 },
        { id: "c2", type: "chat_velocity_below", value: 3 },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "trigger_full_forge", delayMs: 0 },
      ],
      cooldownMs: 300000,
      maxFires: 0,
    },
  },
  {
    name: "Toxic Sentiment Alert",
    description: "When sentiment turns toxic, notify the user and lock mood to calm.",
    rule: {
      name: "Toxic Sentiment Alert",
      description: "Alert on toxic chat sentiment",
      enabled: true,
      conditions: [
        { id: "c1", type: "sentiment_is", sentimentLabel: "toxic" },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "notify_user", notification: "Chat sentiment has turned toxic", delayMs: 0 },
        { id: "a2", type: "change_mood", mood: "calm", delayMs: 500 },
      ],
      cooldownMs: 120000,
      maxFires: 0,
    },
  },
  {
    name: "Mention Auto-Respond",
    description: "When the bot is mentioned, force an AutoForge check to respond immediately.",
    rule: {
      name: "Mention Auto-Respond",
      description: "Force AutoForge on mention",
      enabled: true,
      conditions: [
        { id: "c1", type: "mention_detected" },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "force_autoforge_check", delayMs: 0 },
      ],
      cooldownMs: 30000,
      maxFires: 0,
    },
  },
  {
    name: "Keyword Alert",
    description: "When a specific keyword is detected in chat, notify the user. Customize the keyword after adding.",
    rule: {
      name: "Keyword Alert",
      description: "Alert when a keyword appears in chat",
      enabled: true,
      conditions: [
        { id: "c1", type: "keyword_detected", keyword: "giveaway" },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "notify_user", notification: "Keyword detected in chat!", delayMs: 0 },
      ],
      cooldownMs: 60000,
      maxFires: 0,
    },
  },
  {
    name: "Stream Dead Check",
    description: "When stream health drops to 'dead', notify the user. Useful for monitoring stream health.",
    rule: {
      name: "Stream Dead Check",
      description: "Alert when stream health is dead",
      enabled: true,
      conditions: [
        { id: "c1", type: "stream_health_is", healthLabel: "dead" },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "notify_user", notification: "Stream health is critical — chat appears dead", delayMs: 0 },
      ],
      cooldownMs: 300000,
      maxFires: 0,
    },
  },
  {
    name: "New Viewer Milestone",
    description: "When viewer count crosses a threshold, send a welcome message. Set your threshold after adding.",
    rule: {
      name: "New Viewer Milestone",
      description: "Welcome viewers at milestone",
      enabled: true,
      conditions: [
        { id: "c1", type: "viewer_count_above", value: 100 },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "send_message", payload: "Thanks for hanging out everyone! 🎉", delayMs: 0 },
      ],
      cooldownMs: 600000,
      maxFires: 1,
    },
  },
  {
    name: "Late Night Stand Down",
    description: "After 2am local time, turn AutoForge off and notify. Useful for letting the bot rest overnight.",
    rule: {
      name: "Late Night Stand Down",
      description: "Disable AutoForge late at night",
      enabled: true,
      conditions: [
        { id: "c1", type: "time_of_day_after", hour: 2 },
        { id: "c2", type: "autoforge_is_enabled" },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "toggle_autoforge", enabled: false, delayMs: 0 },
        { id: "a2", type: "notify_user", notification: "AutoForge disabled for the night.", delayMs: 500 },
      ],
      cooldownMs: 3600000,
      maxFires: 0,
    },
  },
  {
    name: "Dead Chat Backoff",
    description: "After 5 consecutive silence cycles, raise the confidence threshold so the bot waits for stronger moments before speaking.",
    rule: {
      name: "Dead Chat Backoff",
      description: "Raise threshold during dead periods",
      enabled: true,
      conditions: [
        { id: "c1", type: "consecutive_silence_above", value: 5 },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "set_confidence_threshold", confidenceThreshold: 0.7, delayMs: 0 },
      ],
      cooldownMs: 600000,
      maxFires: 0,
    },
  },
  {
    name: "Toxic Mood Reset",
    description: "When sentiment turns toxic, lock mood to calm. When it clears, release the lock automatically.",
    rule: {
      name: "Toxic Mood Reset",
      description: "Clear mood lock when sentiment recovers",
      enabled: true,
      conditions: [
        { id: "c1", type: "sentiment_is_not", sentimentLabel: "toxic" },
        { id: "c2", type: "mood_is", mood: "calm" },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "clear_mood_lock", delayMs: 0 },
      ],
      cooldownMs: 120000,
      maxFires: 0,
    },
  },
  {
    name: "Raid Mode",
    description: "When viewer count spikes above 200 AND hype is high, switch to short messages and force an AutoForge check to react fast.",
    rule: {
      name: "Raid Mode",
      description: "Short messages + immediate check on raid",
      enabled: true,
      conditions: [
        { id: "c1", type: "viewer_count_above", value: 200 },
        { id: "c2", type: "hype_level_above", value: 2 },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "set_length_preference", lengthPreference: "short", delayMs: 0 },
        { id: "a2", type: "force_autoforge_check", delayMs: 1000 },
      ],
      cooldownMs: 300000,
      maxFires: 0,
    },
  },
  {
    name: "Single Bot Guard",
    description: "When only one bot is active, lower the confidence threshold so it speaks more freely. When more bots come online, the threshold resets.",
    rule: {
      name: "Single Bot Guard",
      description: "Lower threshold for solo bot",
      enabled: true,
      conditions: [
        { id: "c1", type: "active_bot_count_below", value: 2 },
      ],
      conditionOperator: "and",
      actions: [
        { id: "a1", type: "set_confidence_threshold", confidenceThreshold: 0.35, delayMs: 0 },
      ],
      cooldownMs: 600000,
      maxFires: 0,
    },
  },
];
