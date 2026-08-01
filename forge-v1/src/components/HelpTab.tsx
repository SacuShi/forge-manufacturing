// FORGE — Help & Guide tab
// Written for EVE Online players. No screenshots — uses CSS mockups that stay accurate.

import { type FC } from 'react';

const S = {
  page: {
    padding: '24px 28px',
    maxWidth: 860,
    margin: '0 auto',
    color: 'var(--color-text-primary)',
    fontSize: 13,
    lineHeight: 1.65,
  } as React.CSSProperties,
  h1: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--color-accent)',
    letterSpacing: 2,
    textTransform: 'uppercase' as const,
    marginBottom: 4,
  },
  tagline: {
    color: 'var(--color-text-secondary)',
    marginBottom: 28,
    fontSize: 13,
  },
  section: {
    marginBottom: 32,
    borderTop: '0.5px solid var(--color-border-light)',
    paddingTop: 20,
  },
  h2: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--color-accent)',
    letterSpacing: 1.5,
    textTransform: 'uppercase' as const,
    marginBottom: 10,
  },
  p: { marginBottom: 10 },
  ul: { paddingLeft: 18, marginBottom: 10 },
  li: { marginBottom: 5 },
  kbd: {
    display: 'inline-block',
    background: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-light)',
    borderRadius: 3,
    padding: '1px 6px',
    fontSize: 11,
    fontFamily: 'var(--font-mono, monospace)',
    color: 'var(--color-text-primary)',
    verticalAlign: 'middle',
  } as React.CSSProperties,
  tip: {
    background: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-light)',
    borderLeft: '3px solid var(--color-accent)',
    borderRadius: 4,
    padding: '10px 14px',
    marginBottom: 12,
    fontSize: 12,
    color: 'var(--color-text-secondary)',
  } as React.CSSProperties,
  mockup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    background: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-light)',
    borderRadius: 4,
    padding: '6px 10px',
    fontSize: 12,
    marginBottom: 8,
  } as React.CSSProperties,
  label: {
    color: 'var(--color-text-tertiary)',
    fontSize: 11,
    letterSpacing: 0.5,
  },
  select: {
    background: 'var(--color-bg-primary)',
    border: '1px solid var(--color-border-light)',
    borderRadius: 3,
    padding: '2px 6px',
    fontSize: 12,
    color: 'var(--color-text-primary)',
  } as React.CSSProperties,
  aiPrompt: {
    display: 'block',
    background: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-light)',
    borderRadius: 4,
    padding: '7px 12px',
    marginBottom: 6,
    fontSize: 12,
    fontStyle: 'italic',
    color: 'var(--color-text-secondary)',
  } as React.CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
    marginBottom: 12,
  } as React.CSSProperties,
  card: {
    background: 'var(--color-bg-secondary)',
    border: '1px solid var(--color-border-light)',
    borderRadius: 4,
    padding: '10px 14px',
  } as React.CSSProperties,
  cardTitle: {
    fontWeight: 700,
    fontSize: 12,
    marginBottom: 4,
    color: 'var(--color-text-primary)',
  },
};

const Section: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={S.section}>
    <div style={S.h2}>{title}</div>
    {children}
  </div>
);

const HelpTab: FC = () => (
  <div style={S.page}>

    <div style={S.h1}>F.O.R.G.E. — Pilot's Guide</div>
    <div style={S.tagline}>
      Fabrication, Operations, Resource &amp; Guidance Engine — your AI-powered EVE manufacturing intelligence tool.
    </div>

    {/* ── What is FORGE ── */}
    <Section title="What is FORGE?">
      <p style={S.p}>
        FORGE connects to your EVE Online character via the official ESI (read-only). It pulls your assets,
        blueprints, jobs, skills, wallet, and standings to calculate <strong>real profit figures</strong> — not
        guesses. Everything updates live from ESI market data.
      </p>
      <p style={S.p}>
        FORGE never sees your password and cannot perform any in-game action. It reads data only.
      </p>
      <div style={S.tip}>💡 Add multiple characters using <strong>Add Character</strong> in the left panel.
        FORGE merges their blueprints and assets so you see your full industrial empire at a glance.</div>
    </Section>

    {/* ── Hub selectors ── */}
    <Section title="Hub Selectors — Buy in / Sell at">
      <p style={S.p}>
        The two dropdowns in the top bar control which market hubs FORGE uses for its calculations.
        They are <strong>independent</strong> — set them to match how you actually operate.
      </p>

      {/* Mockup */}
      <div style={S.mockup}>
        <span style={S.label}>BUY IN</span>
        <span style={S.select}>◎ Jita ▾</span>
        <span style={{ color: 'var(--color-text-tertiary)', fontSize: 11 }}>→</span>
        <span style={S.label}>SELL AT</span>
        <span style={S.select}>◎ Amarr ▾</span>
      </div>

      <div style={S.grid}>
        <div style={S.card}>
          <div style={S.cardTitle}>◎ Buy in</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Where you buy raw materials. FORGE uses the cheapest sell-order price at this hub
            to calculate your material costs. Default: Jita — the cheapest source for most inputs.
          </div>
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>◎ Sell at</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Where you sell finished goods. FORGE uses the current lowest sell-order price here
            as your expected revenue. Change this to see profit at Amarr, Dodixie, Rens, or Hek.
          </div>
        </div>
      </div>

      <div style={S.tip}>💡 <strong>Typical setup:</strong> Buy in = Jita, Sell at = wherever you plan to list.
        If you manufacture and sell locally in one hub, set both to the same hub.</div>
    </Section>

    {/* ── Market Opportunities ── */}
    <Section title="Market Opportunities">
      <p style={S.p}>
        The main table ranks every manufacturable item by profitability using live market prices.
        Click any row to open the <strong>True Profit</strong> breakdown on the right — this is the
        accurate per-character figure after your skills, blueprint ME, broker fees, sales tax,
        and manufacturing job costs.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Profit/run</strong> — gross estimate before your personal fees. Good for ranking.</li>
        <li style={S.li}><strong>True Profit</strong> (right panel) — the real number using your character's skills,
          your actual blueprint ME level, your standings-adjusted broker fee, and your manufacturing structure costs.</li>
        <li style={S.li}><strong>ISK/hr</strong> — normalises profit by build time. A slow ship may have high profit/run
          but poor ISK/hr versus a fast module.</li>
        <li style={S.li}><strong>Owned</strong> — BPO = original blueprint, BPC = copy. BPOs can be researched;
          BPCs are single-use.</li>
      </ul>
      <div style={S.tip}>💡 Use the <strong>⚙ Mfg Setup</strong> button in the top bar to set your manufacturing
        solar system, structure type, rigs, and facility tax. This directly affects True Profit accuracy.</div>
    </Section>

    {/* ── Your Blueprints ── */}
    <Section title="Your Blueprints">
      <p style={S.p}>
        Shows every blueprint across all your logged-in characters, with live profit calculations
        against your current hub selection. Sort by profit, margin, ISK/hr, or build time.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Buildable Now</strong> filter — only shows blueprints where you already own
          all required materials across your characters' assets.</li>
        <li style={S.li}><strong>ME level</strong> — research your BPOs to reduce material waste.
          Even ME 5–10 makes a meaningful difference on expensive T2 items.</li>
      </ul>
    </Section>

    {/* ── Research ROI ── */}
    <Section title="Research ROI">
      <p style={S.p}>
        Calculates whether it's worth researching each of your BPOs further, and by how many ME levels.
        Compares the ISK saved per run (from reduced material cost) against the time and job cost
        of the research itself.
      </p>
      <div style={S.tip}>💡 Research ROI uses your <strong>Sell at</strong> hub for sell-price and your
        manufacturing settings for job cost. Set these correctly for accurate recommendations.</div>
    </Section>

    {/* ── Station Trading ── */}
    <Section title="Station Trading">
      <p style={S.p}>
        Finds items to flip at a single station — buy from sell orders, relist as sell orders at a higher price.
        No manufacturing required; pure market play.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Hub picker</strong> — select which station to trade at. This is separate from the
          global hub selectors — it only affects this tab.</li>
        <li style={S.li}><strong>Min margin %</strong> — filters out thin spreads. 5–10% is typical for active items;
          higher margins usually mean lower volume.</li>
        <li style={S.li}><strong>Capital / cycle</strong> — how much ISK you plan to commit per trading cycle.</li>
        <li style={S.li}><strong>My Orders</strong> — shows your live market orders with undercut alerts. A red flag
          means a competitor has already undercut you.</li>
      </ul>
    </Section>

    {/* ── Inter-Hub Arb ── */}
    <Section title="Inter-Hub Arbitrage">
      <p style={S.p}>
        Finds items where the price difference between two hubs is large enough to profit after hauling costs.
        Buy cheap at hub A, transport, sell at hub B.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Buy from / Sell into</strong> — the two hubs you're comparing. Use the ⟺ button
          to swap them instantly.</li>
        <li style={S.li}><strong>Min margin</strong> — minimum spread percentage to show. Set higher to filter noise.</li>
        <li style={S.li}>Click any row to see the full breakdown and configure a haul route with your freighter stats.</li>
      </ul>
      <div style={S.tip}>💡 Jita → Amarr is the classic route. Jita → Dodixie often has better margins for
        Gallente ship/module items that locals prefer to buy locally.</div>
    </Section>

    {/* ── LP Store ── */}
    <Section title="LP Store">
      <p style={S.p}>
        Finds the best ISK/LP redemptions across all NPC loyalty point stores, using your actual
        LP balances loaded at login.
      </p>
      <ul style={S.ul}>
        <li style={S.li}>Select a faction to see its store. Items are sorted by ISK/LP — higher is better.</li>
        <li style={S.li}><strong>Can afford</strong> — items you have enough LP and ISK to redeem right now.</li>
        <li style={S.li}>ISK/LP calculations use the <strong>Sell at</strong> hub for sell-price. Switch hubs
          to see how redemption value changes by market.</li>
      </ul>
      <div style={S.tip}>💡 Faction warfare LP stores (Caldari Navy, Federation Navy etc.) typically have
        the best ISK/LP for popular T2 BPCs and implants. Check these first.</div>
    </Section>

    {/* ── PI ── */}
    <Section title="PI Colonies">
      <p style={S.p}>
        Shows your active planetary industry colonies across all characters — planet type, upgrade level,
        and number of installed pins. Use this to check your PI footprint at a glance without
        logging into each character in EVE.
      </p>
    </Section>

    {/* ── AI Advisor ── */}
    <Section title="AI Advisor — Getting the Most Out of It">
      <p style={S.p}>
        The AI Advisor (Ask F.O.R.G.E. AI button) knows your assets, blueprints, skills, wallet,
        jobs, and live market data. It is specifically trained to answer EVE manufacturing and
        profitability questions — nothing else.
      </p>
      <p style={S.p}><strong>Example prompts that work well:</strong></p>
      <span style={S.aiPrompt}>"What's the most profitable T2 module I can build right now?"</span>
      <span style={S.aiPrompt}>"I have 2 billion ISK — what should I manufacture at Jita to maximise ISK/hr?"</span>
      <span style={S.aiPrompt}>"Which of my blueprints is closest to being fully material-complete?"</span>
      <span style={S.aiPrompt}>"Compare profit for Raven vs Drake across all hubs."</span>
      <span style={S.aiPrompt}>"What LP store gives the best ISK/LP for my current balances?"</span>
      <span style={S.aiPrompt}>"Is it worth researching my Machariel BPO to ME 10?"</span>
      <span style={S.aiPrompt}>"What items should I haul from Jita to Amarr this week?"</span>

      <div style={S.tip}>💡 The AI uses your <strong>real character data</strong> — tell it your budget,
        your available slots, and your preferred activity (manufacturing, reactions, trading) and it
        will give you specific, actionable recommendations rather than generic advice.</div>
      <div style={S.tip}>💡 The AI only answers EVE industry and market questions. It won't help with
        combat, fittings, or anything outside manufacturing and profitability.</div>
    </Section>

    {/* ── Tips ── */}
    <Section title="Efficiency Tips">
      <ul style={S.ul}>
        <li style={S.li}>Log in all your industry alts using <strong>Add Character</strong> — FORGE merges
          blueprints and assets across all of them.</li>
        <li style={S.li}>Set <strong>⚙ Mfg Setup</strong> to your actual structure. An Azbel with T2 ME rigs
          produces very different True Profit figures than an NPC station.</li>
        <li style={S.li}>The <strong>Market Opportunities</strong> table updates prices automatically in the background.
          Leave FORGE open while you plan your build queue — it will stay current.</li>
        <li style={S.li}>True Profit in the right panel respects your blueprint's actual ME level. If you see a
          worse number than the table estimate, check your ME level in <strong>⚙ Mfg Setup</strong>.</li>
        <li style={S.li}>For T2 manufacturing, set <strong>Buy in</strong> to Jita even if you sell elsewhere —
          T2 materials (particularly moon products) are almost always cheapest at Jita.</li>
      </ul>
    </Section>

  </div>
);

export default HelpTab;
