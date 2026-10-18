'use strict';
// The per-player context handed to the AI advisor on every call: what the character owns, builds and can build.

const { dbAll } = require('./db');
const { INDUSTRY_IMPLANTS } = require('./character-session');
const { KEY_SKILL_IDS, SKILL_GROUPS } = require('./ai-prompt');

// ── AI chat context builder ───────────────────────────────────────────────────
// Builds the player context string passed as the second system block on every
// Claude API call. Separated from the handler so the 115-line block has a name,
// can be read and tested in isolation, and doesn't bury the agentic loop logic.
async function buildPlayerContext({ blueprints, assets, wallet, jobs, skills, total_sp, planets, implants }) {
  const bpoCount = blueprints.filter(b => b.quantity === -1).length;
  const bpcCount = blueprints.filter(b => b.quantity > 0).length;

  // Resolve top asset names from DB (up to 30 most-held stacks)
  const assetsByQty = [...assets].sort((a, b) => b.quantity - a.quantity).slice(0, 30);
  const assetTypeIds = assetsByQty.map(a => a.type_id);
  let assetNameMap = {};
  if (assetTypeIds.length > 0) {
    const placeholders = assetTypeIds.map(() => '?').join(',');
    const nameRows = await dbAll(
      `SELECT type_id, name FROM items WHERE type_id IN (${placeholders})`,
      assetTypeIds
    );
    nameRows.forEach(r => { assetNameMap[r.type_id] = r.name; });
  }
  const assetSummary = assetsByQty
    .map(a => `${assetNameMap[a.type_id] || `#${a.type_id}`}: ${a.quantity.toLocaleString()}`)
    .join(', ');

  // Resolve job product names
  const jobSummary = jobs.length === 0 ? 'None' : jobs.slice(0, 20).map(j => {
    const activity = j.activity_id === 1 ? 'Mfg' : j.activity_id === 9 ? 'Reaction'
      : j.activity_id === 8 ? 'Invention' : j.activity_id === 5 ? 'Copy'
      : j.activity_id === 3 ? 'TE Research' : j.activity_id === 4 ? 'ME Research' : 'Job';
    return `${j.product_name || j.blueprint_type_id} ×${j.runs} [${activity}]`;
  }).join('; ');

  const skillCount = (skills && skills.length) || 0;

  // Player experience tier — calibrates AI response complexity
  const playerSp = total_sp || 0;
  let experienceTier, experienceNote;
  if (playerSp === 0) {
    experienceTier = 'Unknown';
    experienceNote = 'SP unknown — use balanced Intermediate tone.';
  } else if (playerSp < 5_000_000) {
    experienceTier = 'New Player';
    experienceNote = 'New player — plain language, define terms, step-by-step guidance, link to EVE University.';
  } else if (playerSp < 20_000_000) {
    experienceTier = 'Beginner';
    experienceNote = 'Beginner — explain key terms, avoid assuming deep knowledge, suggest further reading.';
  } else if (playerSp < 50_000_000) {
    experienceTier = 'Intermediate';
    experienceNote = 'Intermediate — standard EVE terminology, explain nuances without repeating basics.';
  } else if (playerSp < 100_000_000) {
    experienceTier = 'Experienced';
    experienceNote = 'Experienced — technical detail welcome, skip basics, focus on optimisation.';
  } else if (playerSp < 150_000_000) {
    experienceTier = 'Veteran';
    experienceNote = 'Veteran — highly concise, assume mastery of all standard EVE mechanics.';
  } else {
    experienceTier = 'Expert';
    experienceNote = 'Expert — maximum technical density, peer-level, no hand-holding.';
  }

  // Key skill levels — build level map then format grouped lines for AI context
  const skillLevelMap = {};
  if (Array.isArray(skills)) {
    skills.forEach(s => { skillLevelMap[s.skill_id] = s.active_skill_level; });
  }

  const skillGroupLines = SKILL_GROUPS
    .map(({ label, ids }) => {
      const trained = ids
        .filter(id => (skillLevelMap[id] || 0) > 0)
        .map(id => `${KEY_SKILL_IDS[id]} L${skillLevelMap[id]}`);
      return trained.length > 0 ? `  ${label}: ${trained.join(', ')}` : null;
    })
    .filter(Boolean);

  // Derived skill values — pre-calculated so the AI doesn't have to
  const concurrentMfgJobs  = 1 + (skillLevelMap[3387]  || 0);
  const concurrentRxnJobs  = 1 + (skillLevelMap[45748] || 0);
  const concurrentResSlots = 1 + (skillLevelMap[3406]  || 0) + (skillLevelMap[24624] || 0);
  const maxMarketOrders    = 5
    + (skillLevelMap[3443]  || 0) * 4
    + (skillLevelMap[3444]  || 0) * 8
    + (skillLevelMap[16596] || 0) * 16
    + (skillLevelMap[18580] || 0) * 32;
  const txTaxRate = (7.5 * (1 - 0.11 * (skillLevelMap[16622] || 0))).toFixed(2);
  const reprYield = (skillLevelMap[3385] || skillLevelMap[3389])
    ? (30 * (1 + 0.03 * (skillLevelMap[3385] || 0)) * (1 + 0.02 * (skillLevelMap[3389] || 0))).toFixed(1)
    : null;
  const piPlanets = 1 + (skillLevelMap[2495] || 0);

  const derivedLines = [
    `Concurrent mfg jobs: ${concurrentMfgJobs}`,
    concurrentRxnJobs > 1 ? `concurrent reaction jobs: ${concurrentRxnJobs}` : null,
    `research slots: ${concurrentResSlots}`,
    maxMarketOrders !== 5 ? `max market orders: ${maxMarketOrders}` : null,
    `transaction tax rate: ${txTaxRate}%`,
    reprYield ? `reprocessing yield (skills only): ${reprYield}%` : null,
    (skillLevelMap[2495] || 0) > 0 ? `PI planets: ${piPlanets}` : null,
  ].filter(Boolean).join(', ');

  const keySkillsBlock = skillGroupLines.length > 0
    ? `Key skill levels:\n${skillGroupLines.join('\n')}\nDerived: ${derivedLines}`
    : `Key skill levels: none of the tracked skills trained yet`;

  // PI colony summary (planet type, CCU level, pin count)
  // Solar system names not resolved here — adds ESI latency with low AI value.
  let piColoniesLine = null;
  if (Array.isArray(planets) && planets.length > 0) {
    const colonyDesc = planets.map(p => {
      const type = p.planet_type
        ? p.planet_type.charAt(0).toUpperCase() + p.planet_type.slice(1)
        : 'Unknown';
      return `${type} CCU${p.upgrade_level ?? '?'} (${p.num_pins ?? 0} pins)`;
    }).join(', ');
    piColoniesLine = `PI colonies (${planets.length} active): ${colonyDesc}`;
  }

  // Industry implants — only the Zainou 'Beancounter' hardwirings are surfaced
  let implantsLine = null;
  if (Array.isArray(implants)) {
    const known = implants.map(id => INDUSTRY_IMPLANTS[id]).filter(Boolean);
    implantsLine = known.length
      ? `Industry implants plugged in: ${known.map(i =>
          `${i.name} (${i.kind === 'mfg_time' ? `−${i.pct}% mfg time` : i.kind === 'reprocessing' ? `+${i.pct}% reprocessing` : `${i.pct}%`})`
        ).join(', ')}`
      : `Industry implants plugged in: none — no Zainou 'Beancounter' industry hardwiring detected (a slot-8 BX-80x would cut build time and lift ISK/hr).`;
  }

  return [
    `Wallet: ${(wallet / 1e9).toFixed(2)}B ISK`,
    `Blueprints: ${blueprints.length} total (${bpoCount} BPOs, ${bpcCount} BPCs)`,
    `Assets: ${assets.length} stacks — top holdings: ${assetSummary}`,
    `Active jobs (${jobs.length}): ${jobSummary}`,
    `Skills trained: ${skillCount} distinct skills`,
    `Total skill points: ${playerSp > 0 ? playerSp.toLocaleString() + ` SP (${experienceTier})` : 'Unknown'}`,
    keySkillsBlock,
    piColoniesLine,
    implantsLine,
    `Response tone: ${experienceNote}`,
  ].filter(Boolean).join('\n');
}

module.exports = { buildPlayerContext };
