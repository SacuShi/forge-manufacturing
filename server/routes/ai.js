'use strict';
// The AI advisor: the chat endpoint (guardrails, then the Claude tool loop), usage/cost tracking and the admin cost report.

const express = require('express');
const fetch = require('node-fetch');
const config = require('../lib/config');
const logger = require('../lib/logger');
const security = require('../forge-security');
const { dbAll, dbGet, dbRun } = require('../lib/db');
const { esiFetch } = require('../lib/esi');
const { clientErrMsg } = require('../lib/http-errors');
const { getCached } = require('../lib/cache');
const { REGIONS, VALID_REGIONS } = require('../lib/hubs');
const { getItemPricesAllRegions } = require('../lib/market-cache');
const { hubBooks } = require('../lib/hub-pollers');
const { CORP_BP_USABLE_SQL, ensureCorpDataFresh, resolveViewerCorpAccess } = require('../lib/corp');
const { AI_REFUSAL, checkCharAiRateLimit, sanitiseMessage, looksLikeInjection, looksOffTopic } = require('../lib/ai-guardrails');
const { FORGE_STATIC_SYSTEM_PROMPT, AI_TOOLS } = require('../lib/ai-prompt');
const { buildPlayerContext } = require('../lib/ai-context');

const PORT = config.port;
const router = express.Router();

// Max tokens the server will ever request from the API, regardless of what the client sends.
const AI_MAX_TOKENS = 2000;

// -- AI tool dispatch (lib/ai-tools.js) --------------------------------------
// Built on first use: several of these (e.g. CORP_BP_USABLE_SQL) are declared further down this file,
// so constructing it here at load time would read them before they exist.
let aiTools = null;

function executeAiTool(...args) {
  if (!aiTools) {
    aiTools = require('../lib/ai-tools').createAiTools({
      CORP_BP_USABLE_SQL, PORT, REGIONS, VALID_REGIONS, dbAll, dbGet, ensureCorpDataFresh, esiFetch, fetch, getItemPricesAllRegions, hubBooks, resolveViewerCorpAccess, security,
    });
  }
  return aiTools.executeAiTool(...args);
}

router.post('/api/ai-chat',
  security.aiLimiter,
  security.verifyEveToken,
  security.validateAiChatInput,
  async (req, res) => {
  try {
    // maxTokens: server caps regardless of client value — never let the caller inflate API cost.
    const { messages } = req.body;
    const maxTokens = AI_MAX_TOKENS;
    const characterId = req.characterId;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }

    // Per-character rate limit (supplements the per-IP aiLimiter).
    if (!checkCharAiRateLimit(characterId)) {
      logger.warn(`⚠ AI guardrail: per-character rate limit hit for character ${characterId}`);
      return res.status(429).json({ error: 'AI rate limit reached for this character, please wait a moment' });
    }

    // Sanitise ALL messages (user AND assistant) — strip zero-width / bidi chars.
    // Previously only user messages were sanitised; an attacker could embed unicode
    // evasion inside client-supplied "assistant" history turns.
    const sanitisedMessages = messages.map(m =>
      m ? { ...m, content: sanitiseMessage(m.content) } : m
    );

    // ── Multi-layer guardrail ──────────────────────────────────────────────────
    // Layer 1: Critical patterns checked on EVERY message in history (user + assistant).
    //   Catches: LLM framework markers, fake "confirmed" assistant turns, encoding attacks.
    for (const m of sanitisedMessages) {
      if (!m) continue;
      if (looksLikeInjection(m.content, { critical: true, sensitive: false })) {
        logger.warn(`⚠ AI guardrail [critical-history] role=${m.role} char=${characterId}: "${m.content.slice(0, 80)}"`);
        return res.json({ content: [{ type: "text", text: AI_REFUSAL }], guardrail: "blocked_history" });
      }
    }

    // Layer 2: Full pattern set (critical + sensitive) checked on the latest user message.
    //   Sensitive patterns not run on history to avoid false-positives on old EVE phrases.
    const lastUserMsg = [...sanitisedMessages].reverse().find(m => m && m.role === 'user');
    if (lastUserMsg && looksLikeInjection(lastUserMsg.content)) {
      logger.warn(`⚠ AI guardrail [last-user] char=${characterId}: "${lastUserMsg.content.slice(0, 120)}"`);
      return res.json({ content: [{ type: "text", text: AI_REFUSAL }], guardrail: "blocked" });
    }

    // Layer 3: Off-topic pre-filter on the latest user message.
    if (lastUserMsg && looksOffTopic(lastUserMsg.content)) {
      logger.warn(`⚠ AI guardrail [off-topic] char=${characterId}: "${lastUserMsg.content.slice(0, 120)}"`);
      return res.json({ content: [{ type: "text", text: AI_REFUSAL }], guardrail: "off_topic" });
    }

    // Load session data from cache
    const sessionKey = `session:${characterId}`;
    const sessionData = getCached(sessionKey);
    
    logger.debug(`🔍 AI Chat - Character: ${characterId}, Session Key: ${sessionKey}, Cache Hit: ${!!sessionData}`);
    
    if (!sessionData) {
      logger.error(`❌ No session data found for character ${characterId}`);
      return res.status(400).json({ 
        error: "No session data found. Please refresh the page to reload your character data.",
        code: "SESSION_EXPIRED"
      });
    }

    logger.debug(`✓ Session data loaded: ${sessionData.assets?.length || 0} assets, ${sessionData.blueprints?.length || 0} blueprints`);

    const { assets, blueprints, prices, wallet, jobs, skills, total_sp, planets, implants } = sessionData;

    const apiKey = config.anthropicApiKey;
    if (!apiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    }

    const builtContext = await buildPlayerContext({ blueprints, assets, wallet, jobs, skills, total_sp, planets, implants });

    const tools = AI_TOOLS;

    // Trim history to last 30 messages
    let conversationMessages = sanitisedMessages.slice(-10);

    // Max 5 tool-use iterations to prevent infinite loops
    const maxIterations = 5;
    let iteration = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;

    while (iteration < maxIterations) {
      iteration++;

      const requestBody = {
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: FORGE_STATIC_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" }
          },
          {
            type: "text",
            text: `Current player context:\n${builtContext}`
          }
        ],
        messages: conversationMessages,
        tools: tools
      };

      logger.debug(`🤖 AI request (iteration ${iteration})`);

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31"
        },
        body: JSON.stringify(requestBody)
      });

      const data = await aiRes.json();

      if (!aiRes.ok) {
        logger.error("AI error:", data.error?.message);
        return res.json({ 
          content: [{ type: "text", text: `[API Error: ${data.error?.message || "AI request failed"}]` }],
          error: data.error?.message || "AI request failed"
        });
      }

      // Accumulate token usage across iterations (v0.9.0)
      if (data.usage) {
        totalInputTokens += data.usage.input_tokens || 0;
        totalOutputTokens += data.usage.output_tokens || 0;
        totalCacheCreationTokens += data.usage.cache_creation_input_tokens || 0;
        totalCacheReadTokens += data.usage.cache_read_input_tokens || 0;
      }

      // Check if AI used tools
      const toolUses = data.content.filter(block => block.type === "tool_use");

      if (toolUses.length === 0) {
        // No tools used - final answer
        logger.debug("✓ AI response generated (no tools)");

        // Track cumulative AI usage (v0.9.0)
        trackAiUsage(characterId, requestBody.model, {
          input_tokens: totalInputTokens,
          output_tokens: totalOutputTokens,
          cache_creation_input_tokens: totalCacheCreationTokens,
          cache_read_input_tokens: totalCacheReadTokens
        });

        return res.json(data);
      }

      // AI used tools - execute them
      logger.debug(`🔧 AI used ${toolUses.length} tool(s)`);

      const toolResults = [];

      for (const toolUse of toolUses) {
        logger.info(`  → ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 100)}...)`);

        const toolResult = await executeAiTool(toolUse, { characterId, req, jobs, blueprints, assets });

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(toolResult)
        });
      }

      // Add assistant's tool use and tool results to conversation
      conversationMessages.push({
        role: "assistant",
        content: data.content
      });

      conversationMessages.push({
        role: "user",
        content: toolResults
      });

      // Loop back to call AI again with tool results
    }

    // If we hit max iterations, return what we have
    logger.warn("⚠ Max tool iterations reached");
    trackAiUsage(characterId, 'claude-sonnet-4-6', {
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cache_creation_input_tokens: totalCacheCreationTokens,
      cache_read_input_tokens: totalCacheReadTokens
    });
    return res.json({ 
      content: [{ type: "text", text: "I encountered an issue processing your request. Please try again." }] 
    });

  } catch (err) {
    logger.error("AI chat error:", err.message);
    res.json({ 
      content: [{ type: "text", text: `[System Error: ${clientErrMsg(err)}]` }],
      error: clientErrMsg(err)
    });
  }
});

// AI COST TRACKING (v0.9.0)

// Sonnet 4.6 pricing (per million tokens, as of 2026)
const AI_PRICING = {
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-20250514': { input: 3.00, output: 15.00 }
};

async function trackAiUsage(characterId, model, usage) {
  try {
    const pricing = AI_PRICING[model] || { input: 3.00, output: 15.00 };

    const regularInputCost = (usage.input_tokens || 0)                               * pricing.input         / 1_000_000;
    const cacheWriteCost   = (usage.cache_creation_input_tokens || 0) * pricing.input * 1.25   / 1_000_000;
    const cacheReadCost    = (usage.cache_read_input_tokens || 0)     * pricing.input * 0.1    / 1_000_000;
    const outputCost       = (usage.output_tokens || 0)                               * pricing.output        / 1_000_000;

    const estimatedCost    = regularInputCost + cacheWriteCost + cacheReadCost + outputCost;
    const totalInputTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);

    await dbRun(`
      INSERT INTO ai_usage (character_id, model, input_tokens, output_tokens, estimated_cost)
      VALUES (?, ?, ?, ?, ?)
    `, [characterId, model, totalInputTokens, usage.output_tokens || 0, estimatedCost]);
  } catch (err) {
    logger.error('AI usage tracking error:', err.message);
    // Non-fatal — don't break the response
  }
}

// Admin: View AI costs
router.get('/api/admin/ai-costs', security.adminLimiter, async (req, res) => {
  const adminKey = config.adminKey;
  const providedKey = req.headers['x-admin-key'];

  if (!adminKey || providedKey !== adminKey) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // Today
    const today = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now')
    `);

    // Last 7 days
    const week = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now', '-7 days')
    `);

    // Last 30 days
    const month = await dbGet(`
      SELECT COUNT(*) as requests,
             SUM(input_tokens) as input_tokens,
             SUM(output_tokens) as output_tokens,
             SUM(estimated_cost) as total_cost
      FROM ai_usage
      WHERE created_at >= date('now', '-30 days')
    `);

    // Daily breakdown (last 7 days)
    const daily = await dbAll(`
      SELECT date(created_at) as date,
             COUNT(*) as requests,
             SUM(estimated_cost) as cost
      FROM ai_usage
      WHERE created_at >= date('now', '-7 days')
      GROUP BY date(created_at)
      ORDER BY date DESC
    `);

    res.json({ today, week, month, daily });

  } catch (err) {
    res.status(500).json({ error: clientErrMsg(err) });
  }
});

module.exports = router;
