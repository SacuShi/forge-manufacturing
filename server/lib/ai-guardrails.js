'use strict';
// Guardrails in front of the AI advisor: a per-character rate limit, input sanitising, and the prompt-injection and
// off-topic checks. See the AI security notes: these run BEFORE anything reaches the model.

// AI CHAT - Anthropic proxy with function calling
// ── AI guardrail (v1.30.0) ───────────────────────────────────────────────────
// Canonical refusal — kept in sync with the REFUSAL PROTOCOL line in the system prompt.
const AI_REFUSAL = "I'm F.O.R.G.E. — I only help with EVE Online industry, markets, and pricing. Ask me about builds, blueprints, profit, or what to produce.";

// Per-character AI rate limit — supplements the per-IP aiLimiter.
// Prevents a single EVE account from exhausting the token budget via VPN-hopping.
const _charAiWindow = new Map(); // characterId → [timestamps]

const CHAR_AI_LIMIT  = 20;              // max requests per 10-min window

const CHAR_AI_WIN_MS = 10 * 60 * 1000; // 10 minutes

function checkCharAiRateLimit(characterId) {
  const now    = Date.now();
  const cutoff = now - CHAR_AI_WIN_MS;
  const hits   = (_charAiWindow.get(characterId) || []).filter(t => t > cutoff);
  if (hits.length >= CHAR_AI_LIMIT) return false;
  hits.push(now);
  _charAiWindow.set(characterId, hits);
  return true;
}

// Periodically evict characterIds whose entire window has expired to prevent unbounded growth.
setInterval(() => {
  const cutoff = Date.now() - CHAR_AI_WIN_MS;
  for (const [id, times] of _charAiWindow) {
    if (!times.some(t => t > cutoff)) _charAiWindow.delete(id);
  }
}, CHAR_AI_WIN_MS);

// Strip invisible/dangerous Unicode before any other processing:
//   • Zero-width characters (U+200B–U+200D, U+FEFF) — used to split trigger words
//   • Bidirectional text overrides (U+202A–U+202E, U+2066–U+2069) — used to reverse text visually
//   • C0/C1 control characters except \t \n \r — not needed in chat, occasionally used in attacks
function sanitiseMessage(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/[​-‍﻿]/g, '')           // Zero-width spaces / BOM
    .replace(/[‪-‮⁦-⁩]/g, '')   // Bidirectional text overrides
    .replace(/[\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f]/g, ''); // C0/C1 control chars
}

// ── Injection pattern tiers (v1.31.0) ─────────────────────────────────────────
//
// CRITICAL — checked on ALL messages in the history, including client-supplied
//   "assistant" turns (which an attacker could populate with fake "confirmations").
//   These patterns cannot appear in a normal EVE manufacturing conversation.
//
// SENSITIVE — checked only on the latest user message to avoid false positives
//   on legitimate EVE phrases ("going forward, what should I produce?").

const AI_CRITICAL_INJECTION_PATTERNS = [
  // LLM framework injection markers
  /<<<|>>>|\[\[SYSTEM\]\]|\[\[\/SYSTEM\]\]|\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>/,
  // Bracket-injected SYSTEM blocks (e.g. "[SYSTEM] You are now...")
  /\[SYSTEM[\s\]]/i,
  // Explicit jailbreak vocabulary
  /\bjailbreak/i,
  // Special-mode claims
  /\b(developer|dan|sudo|god|admin|debug|maintenance|override)\s+mode\b/i,
  // Encoding/obfuscation attacks
  /\b(base64|rot[\s-]?13|hex[\s-]?encoded?|url[\s-]?encoded?)\b.*\b(decode|decipher|translate|render|convert)\b/i,
  /\b(decode|decipher|translate|render|convert)\b.*\b(base64|rot[\s-]?13|hex[\s-]?encoded?|url[\s-]?encoded?)\b/i,
  // Fake "confirmed" assistant turn — attacker plants a prior fake acceptance
  /\b(confirmed|understood|acknowledged)[.,!]?\s*(i will|i'll|from now|going forward).{0,80}(without\s+restriction|no\s+(restriction|limit|filter|constraint)|ignor)/i,
];

const AI_SENSITIVE_INJECTION_PATTERNS = [
  // ── Instruction override ──────────────────────────────────────────────────
  /ignore\s+(all\s+|your\s+|the\s+|any\s+|these\s+)*(previous|prior|earlier|above|preceding|system)\s+(instruction|prompt|rule|message|context|direction)/i,
  /disregard\s+(all\s+|your\s+|the\s+|these\s+)*(previous|prior|system|above)\s+(instruction|prompt|rule|message)/i,
  /forget\s+(everything|all|your|the|previous|prior)\s+(instruction|rule|prompt|context|you)/i,
  /\b(from\s+(now|this\s+point|this\s+moment|here)\s+on|starting\s+(now|immediately))\b.{0,60}\b(you\s+(will|must|should|are)|respond|ignore|act|behave|forget|disregard)/i,
  // ── System prompt extraction ──────────────────────────────────────────────
  /(reveal|show|print|repeat|output|expose|display|give\s+me)\s+(me\s+)?(your\s+|the\s+|these\s+)?(system\s+|initial\s+|original\s+)?(prompt|instructions|guidelines|directive)/i,
  /what\s+(is|are|were)\s+(your\s+(system\s+|initial\s+|original\s+)?|the\s+(system|initial|original)\s+)(prompt|instructions)/i,
  // ── Identity override ─────────────────────────────────────────────────────
  /you\s+are\s+(now\s+)?(no\s+longer|not)\s+(f\.?o\.?r\.?g\.?e|forge)/i,
  /you\s+are\s+(now\s+)?(a\s+|an\s+)?(unrestricted|uncensored|unfiltered|general[\s-]?purpose|normal|regular|different|new)\s+(ai|assistant|llm|chatbot|model|gpt|bot)/i,
  /(act|behave|respond|talk|pretend)\s+(as\s+|like\s+|to\s+be\s+)(if\s+you\s+(are|were)\s+)?(an?\s+)?(unrestricted|uncensored|unfiltered|general[\s-]?purpose|normal|regular)\s+(ai|assistant|llm|chatbot|model|gpt)/i,
  // Pretend-you-are-an-AI (FIXED: old negative lookahead was bypassed by appending "caldari")
  /pretend\s+(you\s+are|to\s+be)\s+(an?\s+)?(ai|assistant|llm|chatbot|language\s+model|gpt|bot)\b/i,
  /pretend\s+(you\s+are|to\s+be)\s+.{0,100}\b(unrestricted|uncensored|unfiltered|without\s+restriction|no\s+(restriction|filter|limit))\b/i,
  // Story / roleplay / hypothetical framing — used to launder off-topic requests
  /(for\s+a\s+(story|novel|roleplay|game|creative\s+writing|fiction|narrative)|as\s+a\s+creative\s+exercise|imagine\s+you\s+(have\s+no|without)\s+(restriction|limit|filter|constraint|rule)|hypothetically[,\s].{0,60}(if\s+you\s+(had\s+no|were\s+not)|without\s+your\s+(restrict|limit|rule|constraint)))/i,
  // ── Indirect / encoding attacks ───────────────────────────────────────────
  /(translate|repeat|say|echo|output|write\s+out)\s+(the\s+|this\s+|following\s+)?(following|text|words?|sentence|phrase)\s*:/i,
];

function looksLikeInjection(text, { critical = true, sensitive = true } = {}) {
  if (typeof text !== 'string') return false;
  if (critical && AI_CRITICAL_INJECTION_PATTERNS.some(re => re.test(text))) return true;
  if (sensitive && AI_SENSITIVE_INJECTION_PATTERNS.some(re => re.test(text))) return true;
  return false;
}

// Off-topic pre-filter — blocks questions that are clearly unrelated to EVE manufacturing /
// profitability BEFORE they reach the Claude API, protecting tokens from bad actors.
// Patterns are conservative: only things that could not plausibly be EVE questions.
const AI_OFFTOPIC_PATTERNS = [
  // Other games
  /\b(minecraft|world\s+of\s+warcraft|wow|fortnite|valorant|league\s+of\s+legends|dota|counter[\s-]?strike|call\s+of\s+duty|apex\s+legends|overwatch|pokemon|roblox|genshin|final\s+fantasy(?!\s+xiv.*corp)|star\s+wars(?!\s+galaxies)|runescape|hearthstone|warframe|destiny\s+2|elder\s+scrolls(?!\s+online.*industry)|skyrim|diablo|path\s+of\s+exile|baldur|terraria|stardew|hades|elden\s+ring|dark\s+souls)\b/i,
  // Real-world food / cooking
  /\b(recipe|ingredient|cook(ing)?|bake|baking|oven|microwave|boil|fry|roast|saute|grill|simmer)\b.{0,60}\b(how|what|step|time|temperature|degree|minute|cup|gram|ounce|tablespoon|teaspoon)\b/i,
  // Coding / programming help (not EVE-related)
  /\b(write\s+(me\s+)?(a\s+)?(python|javascript|java|c\+\+|c#|php|ruby|golang|rust|typescript|sql|html|css|bash|powershell)\s+(script|code|program|function|class|snippet))/i,
  /\b(debug|fix|refactor)\s+(my|this|the)\s+(code|script|function|class|program|bug)\b/i,
  // Real-world homework / essays
  /\b(write\s+(me\s+)?(an?\s+)?(essay|paragraph|letter|email|report|summary|thesis|assignment|homework))\b/i,
  /\b(summarize|summarise)\s+(this\s+)?(article|book|paper|document|text|chapter)\b/i,
  // Weather / news / sports
  /\b(weather|forecast|temperature)\s+(in|for|at|today|tomorrow|this\s+week)\b/i,
  /\b(who\s+won|what\s+is\s+the\s+score|latest\s+news|breaking\s+news|headline)\b/i,
  /\b(nfl|nba|nhl|mlb|fifa|premier\s+league|champions\s+league|world\s+cup)\s+(score|result|winner|game|match|season)\b/i,
  // Medical / legal / financial (real world)
  /\b(diagnose|symptom|medication|drug\s+interaction|dosage|prescription)\b/i,
  /\b(legal\s+advice|is\s+it\s+legal|lawsuit|sue|attorney|lawyer)\b/i,
  /\b(invest\s+in\s+(stock|share|crypto|bitcoin|ethereum)|buy\s+(bitcoin|eth|crypto|stock))\b/i,
  // Generic chatbot / AI requests
  /\b(tell\s+me\s+a\s+(joke|story|poem|riddle|fact))\b/i,
  /\b(translate\s+(this\s+)?(to|into)\s+(english|french|spanish|german|chinese|japanese|korean|russian|italian|portuguese))\b/i,
  /\b(what\s+is\s+the\s+meaning\s+of\s+life|are\s+you\s+(sentient|conscious|alive|human|a\s+real)|do\s+you\s+have\s+feelings)\b/i,
];

function looksOffTopic(text) {
  return typeof text === 'string' && AI_OFFTOPIC_PATTERNS.some(re => re.test(text));
}

module.exports = { AI_REFUSAL, checkCharAiRateLimit, sanitiseMessage, looksLikeInjection, looksOffTopic };
