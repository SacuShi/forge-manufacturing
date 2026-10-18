// FORGE — Help & Guide tab
// Written for EVE Online players. No screenshots — uses CSS mockups that stay accurate.

import { type FC } from 'react';

const S = {
  page: {
    padding: '24px 28px',
    maxWidth: 880,
    margin: '0 auto',
    color: 'var(--color-text-primary)',
    fontSize: 13,
    lineHeight: 1.65,
  } as React.CSSProperties,
  h1: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--color-accent-primary)',
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
    color: 'var(--color-accent-primary)',
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
    borderLeft: '3px solid var(--color-accent-primary)',
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
  bpBadge: (color: string) => ({
    display: 'inline-block',
    fontSize: 10,
    fontWeight: 700,
    padding: '1px 5px',
    borderRadius: 3,
    background: color,
    color: '#fff',
    marginRight: 4,
    verticalAlign: 'middle',
  } as React.CSSProperties),
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
        FORGE connects to your EVE Online character via the official ESI API (read-only). It pulls your assets,
        blueprints, active industry jobs, skills, wallet balance, loyalty points, and standings —
        then uses live market data to calculate <strong>real profit figures</strong>, not guesses.
      </p>
      <p style={S.p}>
        FORGE <strong>never sees your password</strong> and cannot perform any in-game action whatsoever.
        It is a read-only intelligence tool. Your EVE credentials only ever go to CCP's login page.
      </p>
      <div style={S.tip}>💡 Add multiple characters (industry alts, corp directors) using <strong>+ Add Character</strong>
        in the left panel. FORGE merges their blueprints and assets so you see your entire industrial empire at a glance.</div>
    </Section>

    {/* ── Hub selectors ── */}
    <Section title="Hub Selectors — Buy in / Sell at">
      <p style={S.p}>
        The two dropdowns in the top bar control which market hubs FORGE uses for every price calculation.
        They are <strong>independent</strong> — set them to match how you actually operate.
      </p>

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
            Where you source raw materials. FORGE uses the <em>cheapest sell-order price</em> at this hub
            to calculate your material costs, working up the order book if you need more than the cheapest
            order holds. Default: Jita — the cheapest source for almost all inputs.
          </div>
        </div>
        <div style={S.card}>
          <div style={S.cardTitle}>◎ Sell at</div>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            Where you sell finished goods. FORGE uses the <em>current lowest sell-order price</em> here
            as your expected revenue. Switch to Amarr, Dodixie, Rens, or Hek to see profit at each.
          </div>
        </div>
      </div>

      <div style={S.tip}>💡 <strong>Typical setup:</strong> Buy in = Jita, Sell at = wherever you plan to list.
        If you manufacture and sell at the same hub, set both identically.</div>

      <p style={S.p}><strong>When a hub doesn't have what you need:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}>Every hub is priced from <strong>its own market</strong> — its own prices, its own stock and its own daily volume.</li>
        <li style={S.li}>If your <strong>Buy in</strong> hub has none of a material for sale, or not enough for the job, FORGE prices
          what the hub <em>can</em> supply at the hub's price and the rest at <strong>Jita's current price</strong>,
          and tells you in an amber notice. Those materials are marked <strong>J</strong> in the materials list:
          you'll have to import or manufacture them.</li>
        <li style={S.li}>If your <strong>Sell at</strong> hub has none of the finished item listed, the sale price is Jita's current
          lowest sell, and fees and freight assume you sell it at Jita.</li>
        <li style={S.li}>A <strong>J</strong> next to a "sellable per day" number means there's no trading data for that hub
          yet, so you're seeing Jita's volume.</li>
        <li style={S.li}>If a hub's prices are still loading you'll see "loading" — FORGE never shows another hub's prices
          under the wrong name.</li>
      </ul>
      <div style={S.tip}>💡 Importing from Jita costs money. Set your haulage costs in <strong>⚙ Mfg Setup → Haulage</strong>
        (the amber notice has a shortcut link) and True Profit will include the freight for the Jita leg
        using your <strong>Materials in</strong> rates.</div>
    </Section>

    {/* ── Mfg Setup ── */}
    <Section title="⚙ Manufacturing Setup">
      <p style={S.p}>
        Click <strong>⚙ Mfg Setup</strong> in the top bar to tell FORGE about your manufacturing structure.
        This is critical — the True Profit calculation changes significantly depending on where you build.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Solar system</strong> — affects the system cost index (SCI), a CONCORD tax on every
          manufacturing job. Low-activity systems have lower SCI; busy systems like Jita 4-4 have very high SCI.</li>
        <li style={S.li}><strong>Structure type</strong> — Raitaru, Azbel, Sotiyo (engineering complexes) each give
          different material and time efficiency bonuses. NPC stations give no bonus at all.</li>
        <li style={S.li}><strong>Rigs</strong> — T1 and T2 ME/TE rigs on your structure further reduce material waste
          or build time, but <em>only for the item types each rig is built for</em> (a ship rig doesn't help modules).
          FORGE follows the game's rules: at most 3 rigs, the rig size must match your structure (Raitaru M, Azbel L,
          Sotiyo XL), and an NPC station takes none. Rig bonuses are also multiplied by the security of your system
          (×1.9 in lowsec, ×2.1 in nullsec and wormholes), and the panel shows each rig's real value and whether it applies
          to the item you're looking at. A rig that can't apply is flagged instead of being counted.</li>
        <li style={S.li}><strong>Facility tax</strong> — the structure owner's tax on top of the SCI. Often 0–3% in
          alliance structures; up to 10% or more in public citadels.</li>
        <li style={S.li}><strong>Haulage</strong> — tick <em>Haulage Costs</em> and set your rates so freight is part of True Profit.
          <em> Materials in</em> covers the run from your Buy in hub to your build system, and also any materials you have to
          import from Jita when your Buy in hub doesn't stock them. <em>Goods out</em> covers the run to your Sell at hub.</li>
        <li style={S.li}><strong>Install-cost check</strong> — compares what CCP actually charged for your running jobs with FORGE's
          estimate, so you can spot a wrong system, structure or tax setting.</li>
        <li style={S.li}><strong>Suggestions from other pilots</strong> — for a system and structure type, FORGE can show the rig sets
          other pilots report, with a one-click <em>Use these</em>. It's anonymous, only appears once at least two pilots report
          the same thing, and never changes your setup without you saving it. Always check it matches your structure.</li>
      </ul>
      <div style={S.tip}>💡 An Azbel with T2 ME rigs for your item category can improve profit by 5–15% vs an NPC
        station. Always set this to your actual build location for accurate numbers.</div>
    </Section>

    {/* ── Market Opportunities ── */}
    <Section title="Market Opportunities">
      <p style={S.p}>
        The main table ranks every manufacturable item by profitability using live market prices.
        Click any row to open the <strong>True Profit</strong> panel on the right — the full per-character
        breakdown after your skills, blueprint ME, broker fees, sales tax, and job costs.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Profit/run</strong> — gross revenue minus material cost. No fees applied. Good for quick ranking.</li>
        <li style={S.li}><strong>Margin %</strong> — profit as a percentage of sell price. Higher margin = more cushion if prices move against you.</li>
        <li style={S.li}><strong>ISK/hr</strong> — profit normalised by build time. A slow battleship may have a high profit/run
          but poor ISK/hr compared to a fast-building T2 module. <em>This is usually the best column to sort by.</em></li>
        <li style={S.li}><strong>Owned</strong> — whether you have a BPO or BPC for this item (shown in the right panel).</li>
      </ul>
      <div style={S.tip}>💡 Use <strong>⚙ Mfg Setup</strong> to set your manufacturing structure before reading True Profit —
        the number in the table is an estimate; the right panel is the accurate figure for your specific character and structure.</div>

      <p style={S.p}><strong>Reading the True Profit panel:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Amber boxes</strong> tell you exactly which assumption a figure leans on: materials priced at Jita
          because your hub doesn't stock them, a sale priced at Jita, no price for an item, skills not loaded yet, a rig that
          doesn't apply, or a thin market where the lowest sell is far above any buy order. Read them before trusting a number.</li>
        <li style={S.li}><strong>Materials</strong> are priced the way you'd really buy them: your hub's cheapest orders first, working up
          its order book, with any shortfall taken from Jita. Quantities follow the game's rounding — one rounding for the
          whole job, not per run.</li>
        <li style={S.li}>Pick a character in the <strong>True Profit</strong> drop-down to price fees and build time with
          <em> that</em> character's own skills (Accounting, Broker Relations, Industry…).</li>
        <li style={S.li}>The <strong>Market Opportunities</strong> table is a quick, rough ranking (lowest-sell prices, no fees, no
          freight). The right-hand panel is the full, personalised figure.</li>
      </ul>
    </Section>

    {/* ── Your Blueprints ── */}
    <Section title="Your Blueprints">
      <p style={S.p}>
        Shows every blueprint across all your logged-in characters with live profit calculations.
        Sort by ISK/hr, margin, total profit, ME level, or name.
      </p>
      <p style={S.p}><strong>Blueprint icon types:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}><span style={S.bpBadge('#2563eb')}>BPO</span> <strong>Blueprint Original</strong> — permanent, can be researched to higher ME/TE levels, can produce unlimited copies.</li>
        <li style={S.li}><span style={S.bpBadge('#6b7280')}>BPC</span> <strong>Blueprint Copy</strong> — finite number of runs remaining. Cannot be researched. Cheaper to acquire.</li>
        <li style={S.li}>Reaction Formulas (teal icon) and Sleeper Data Interfaces (orange icon) follow the same BPO/BPC rules.</li>
      </ul>
      <ul style={S.ul}>
        <li style={S.li}><strong>Can Build Now</strong> — only shows blueprints you could start building right now: either you
          already own <em>all</em> the materials (across your characters' combined assets), or you're missing some but your
          wallet can afford to buy the rest. Missing materials are priced at the cheapest sell orders at your Buy in hub
          (Jita's price for anything the hub doesn't stock).</li>
        <li style={S.li}>It's a cautious estimate: it uses the ME 0 material list for a single run (so a researched blueprint
          needs less than it assumes), it doesn't check skills, install fees or freight, and items locked in Asset Safety don't
          count as owned. If prices are still loading the pill may briefly show nothing, then fills in by itself.</li>
        <li style={S.li}>If <strong>Can Build Now</strong> is ticked and you see a blueprint, but the right panel shows
          a red "Missing Materials" warning — check whether you also see a green <em>"You have enough ISK to buy the missing materials"</em> message.
          This means your wallet covers the shortfall; use the <strong>📋 Multibuy</strong> button to copy the shopping list for EVE's Multibuy window.</li>
        <li style={S.li}><strong>ME level</strong> — material efficiency research level. ME 10 is the maximum for T1 items.
          Even ME 5 meaningfully reduces material cost on expensive T2 products.</li>
      </ul>
      <p style={S.p}><strong>Blueprints in Asset Safety:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}>When a structure is destroyed (or you trigger Asset Safety by hand), its contents are bundled into an
          <em> Asset Safety Wrap</em>. Anything in a wrap — including blueprints — is locked until you release it, so it
          can't be used to build anything.</li>
        <li style={S.li}>FORGE therefore <strong>leaves those blueprints out</strong>: they aren't listed here, don't count as owned,
          and aren't offered by the Queue Planner or the AI advisor. An amber note at the top of this tab says how many are hidden.</li>
        <li style={S.li}>Once you release them in-game (15% of their value to a station in another system, 0.5% within the same system)
          they appear here again automatically. The <strong>My Assets</strong> tab shows what the release would cost.</li>
      </ul>
    </Section>

    {/* ── Research ROI ── */}
    <Section title="Research ROI">
      <p style={S.p}>
        Calculates whether researching each of your BPOs further is worth the time and ISK.
        For each blueprint it shows: ISK saved per run at the next ME level, the cost and time of the research job,
        and how many runs it takes to break even.
      </p>
      <div style={S.tip}>💡 Research ROI uses your <strong>Sell at</strong> hub for sell-price and your Manufacturing Setup
        for job cost. Set those correctly before reading recommendations.</div>
    </Section>

    {/* ── My Assets ── */}
    <Section title="My Assets">
      <p style={S.p}>
        Shows every item across all your characters' hangars, grouped by station or structure.
        Locations are <strong>collapsed by default</strong> — click a location header to expand it and see what's inside.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Search</strong> — filters items by name across all locations simultaneously.</li>
        <li style={S.li}><strong>Sort pills</strong> — Location sorts groups alphabetically; Quantity sorts groups by
          total items; Item sorts rows within each group by name.</li>
        <li style={S.li}><strong>Blueprint icons</strong> — blueprints appear with their correct icon:
          blue = BPO, pale = BPC, teal = Reaction Formula, orange = Sleeper blueprint.</li>
        <li style={S.li}><strong>Click any item</strong> to open its market data and True Profit panel on the right.</li>
        <li style={S.li}><strong>Hide Asset Safety</strong> pill — items locked in Asset Safety wraps are hidden by default because
          you can't use them. Switch the pill off to see them in their own groups, labelled <em>Asset Safety</em>.</li>
      </ul>
      <p style={S.p}><strong>Asset Safety:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}>Asset Safety isn't a station — it's a wrap that holds your items until you release them. After 20 days
          the game moves it to an NPC station in a nearby system, but the items stay locked inside until you pay to release them.</li>
        <li style={S.li}>Items in Asset Safety are <strong>kept out of every calculation</strong>: they don't count as materials you
          own, don't reduce a shortfall, and don't make anything "Can Build Now".</li>
        <li style={S.li}>When you have items in Asset Safety, an amber box shows their value at <strong>current Jita prices</strong> and the
          release cost — <strong>15%</strong> of the value to a station in another system, or <strong>0.5%</strong> to a station in the
          same system as the original structure (you can choose that after 5 days). CCP actually bases the fee on average market
          prices, so treat FORGE's figure as an estimate.</li>
      </ul>
      <p style={S.p}><strong>Sending items to Appraise:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}><kbd style={S.kbd}>Ctrl+click</kbd> a row to add it to your selection (amber highlight). Click again to deselect.</li>
        <li style={S.li}><kbd style={S.kbd}>Shift+click</kbd> selects every row between your first click and this one.</li>
        <li style={S.li}><kbd style={S.kbd}>Left-click</kbd> alone opens the item's detail panel on the right — it does <em>not</em> clear your multi-selection.</li>
        <li style={S.li}>Once items are selected an <strong>Appraise →</strong> button appears in the toolbar.
          Clicking it takes you straight to the Appraise tab with those items pre-loaded and valued
          at your chosen hub. See the <strong>Appraise</strong> section below for what you can do there.</li>
      </ul>
      <div style={S.tip}>💡 To value an entire location: expand it, Ctrl+click the first row, then Shift+click the
        last row to select everything in one go.</div>
    </Section>

    {/* ── Appraise ── */}
    <Section title="Appraise">
      <p style={S.p}>
        The Appraise tab values any list of items using FORGE's own live market data — the same prices
        that drive every other calculation in the tool, updated every few minutes from ESI.
        Unlike external appraisal sites, FORGE also has <strong>C-J6MT Keepstar</strong> pricing for
        Imperium members.
      </p>
      <p style={S.p}><strong>Two ways to load items:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}><strong>From Assets</strong> — select items in My Assets and click <strong>Appraise →</strong>.
          Items land in the Appraise tab pre-loaded with correct type IDs, ready to value instantly.</li>
        <li style={S.li}><strong>Paste a list</strong> — copy items from anywhere in EVE (right-click a stack → Copy),
          paste into the text box, and click <strong>Appraise</strong>.
          FORGE accepts the standard EVE clipboard format: <em>Name[tab]Qty</em>, one item per line.</li>
      </ul>
      <p style={S.p}><strong>Hub selector and quick buttons:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}><strong>[Hub] Buy</strong> — the button names whichever hub is selected (Jita Buy, C-J6MT Buy…). It shows the value of your items at that hub's buy-order prices.
          This is what you'd receive selling to buy orders right now — instant, guaranteed ISK,
          but lower than the sell-order price. The number to use when a buyer offers to take your loot in bulk.</li>
        <li style={S.li}><strong>[Hub] Sell</strong> — shows the value at the selected hub's cheapest current sell-order price.
          This is what you could receive if you listed everything at market and were the cheapest seller.
          Higher than buy-order value, but not guaranteed — you have to wait for buyers to come to you.</li>
        <li style={S.li}>The <strong>Hub</strong> pills (Amarr, Dodixie, Hek, Rens, C-J6MT) let you price against any
          trade hub. Switching hub re-appraises immediately using cached data — no delay.</li>
      </ul>
      <p style={S.p}><strong>% adjustment:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}>The <strong>80% / 85% / 90% / 95% / 100%</strong> pills multiply every displayed value
          by that percentage. 90% of Jita buy is the standard offer in null-sec loot-buying contracts
          ("blues loot" buyback programmes). Set the percentage first, then read off your buyback value.</li>
        <li style={S.li}>The column headers update to show the percentage, e.g. <em>"Jita buy (90%)"</em>, so the
          number is never ambiguous.</li>
      </ul>
      <p style={S.p}><strong>Exporting to Goonpraisal:</strong></p>
      <ul style={S.ul}>
        <li style={S.li}>Click <strong>📋 Copy as Multibuy list</strong> to copy your items in EVE's multibuy format
          (<em>Name x Qty</em>, one per line). You can paste this directly into Goonpraisal or the
          in-game Multibuy window (right-click market → Buy Items).</li>
        <li style={S.li}><strong>Open Goonpraisal ↗</strong> copies the list <em>and</em> opens the site in a new tab —
          paste immediately on arrival for a second opinion against Goonpraisal's own price feed.</li>
      </ul>
      <div style={S.tip}>💡 For null-sec loot buyback: use <strong>Jita Buy</strong> at <strong>90%</strong>.
        That combination shows exactly what most buyback programmes will pay for your haul —
        the big cyan number at the top is your cheque.</div>
    </Section>

    {/* ── Active Jobs ── */}
    <Section title="Active Jobs">
      <p style={S.p}>
        Lists all manufacturing, research, and reaction jobs currently running across all your characters.
        Each card shows the product being built, the job type (Manufacturing / ME Research / TE Research / Invention),
        quantity, and time remaining.
      </p>
      <div style={S.tip}>💡 Click any job to open that product's market and profit data in the right panel.</div>
    </Section>

    {/* ── Queue Planner ── */}
    <Section title="Queue Planner">
      <p style={S.p}>
        Helps you fill your characters' available manufacturing slots with the most profitable jobs.
        It reads your current active jobs, calculates how many slots are free on each character,
        and recommends what to build next based on your blueprint library and current market prices.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Time horizon</strong> — how many hours ahead to plan. A 24-hour horizon plans jobs
          that will complete within the next day; 72 hours fills a long weekend queue.</li>
        <li style={S.li}><strong>Active slots</strong> show jobs currently running (greyed out — nothing to do).</li>
        <li style={S.li}><strong>Planned slots</strong> show the recommended next jobs. Each recommendation shows
          the product name, run count, and expected ISK/hr.</li>
      </ul>
      <ul style={S.ul}>
        <li style={S.li}>It prices materials with the same rules as True Profit: your <strong>Buy in</strong> hub first, anything it
          can't supply from Jita. Those materials are marked <strong>J</strong> in the shopping list and an amber note says how many
          you'd have to import. The plan figures don't include freight; open an item's True Profit for the figure with freight.</li>
        <li style={S.li}>Reaction jobs are timed with your Reactions skill, and blueprints locked in Asset Safety are never offered.</li>
      </ul>
      <div style={S.tip}>💡 Queue Planner only recommends blueprints you own. Add more characters and their
        blueprints appear automatically in the pool.</div>
    </Section>

    {/* ── PI ── */}
    <Section title="PI Colonies">
      <p style={S.p}>
        Planetary Industry (PI) lets your characters extract raw resources from planets and process them into
        manufactured goods — a passive ISK income stream that runs while you're offline.
      </p>
      <p style={S.p}>
        The PI Colonies tab shows all your active colonies across every character: which planet, its type
        (Barren, Gas, Ice, etc.), its upgrade level (which limits how many extractors and factories you can install),
        and the number of pins currently on it.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>POCO tax rate</strong> — enter the tax your alliance or the POCO owner charges
          for launching PI goods off the planet. This affects profitability calculations.</li>
        <li style={S.li}>Click any planet to see the list of blueprints (PI schematics) installed and their
          input/output materials.</li>
      </ul>
    </Section>

    {/* ── PI Planner ── */}
    <Section title="PI Planner">
      <p style={S.p}>
        If you're setting up PI from scratch or optimising an existing chain, the PI Planner tells you
        <em> which planet in a given region</em> is best suited to produce a target PI product chain.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Select a region</strong> and a <strong>target product</strong> (P1 through P4).
          The planner evaluates every planet in the region against the resource requirements for the full production chain.</li>
        <li style={S.li}>Results rank planets by how many of the required P0 raw materials are available locally,
          minimising the number of planets you need in your chain.</li>
      </ul>
      <div style={S.tip}>💡 The closer a planet can supply all its own inputs, the cheaper your PI setup to run —
        fewer customs office trips, simpler logistics.</div>
    </Section>

    {/* ── Corp ── */}
    <Section title="Corp">
      <p style={S.p}>
        If you hold a Director or equivalent role in your corporation, the Corp tab gives you a read-only view of
        your corporation's blueprint and asset library — the same grouped display as Your Blueprints and
        My Assets, but for corp hangars.
      </p>
      <p style={S.p}>
        Corporation blueprints that are locked in a corp Asset Safety wrap are not offered by the Queue Planner or the AI advisor.
      </p>
      <div style={S.tip}>💡 Corp access requires a character with Director-level ESI permissions logged in.
        If you see "Director access required", add or re-authorise a Director character via Add Character.</div>
    </Section>

    {/* ── Station Trading ── */}
    <Section title="Station Trading">
      <p style={S.p}>
        Station trading means placing buy orders at a station, then relisting what you bought as sell orders
        at a higher price — pure market play, no manufacturing involved. FORGE finds the items with the
        widest spreads so you know where to put your ISK to work.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Hub picker</strong> — which station to trade at. Independent of the global hub selectors.</li>
        <li style={S.li}><strong>Min margin %</strong> — hides thin spreads. 5–10% is typical for active items;
          high-margin items usually trade less frequently.</li>
        <li style={S.li}><strong>Capital / cycle</strong> — how much ISK you want to commit. Affects the
          "max buys" estimate per item.</li>
        <li style={S.li}><strong>My Orders</strong> sub-tab shows your live market orders with undercut alerts.
          A red indicator means a competitor is already cheaper than you.</li>
      </ul>
    </Section>

    {/* ── Inter-Hub Arb ── */}
    <Section title="Inter-Hub Arbitrage">
      <p style={S.p}>
        Inter-hub arbitrage (inter-hub arb) means buying an item cheap at one trade hub and hauling it to
        another hub to sell at a higher price. FORGE compares prices across all major hubs simultaneously
        to find the best opportunities.
      </p>
      <ul style={S.ul}>
        <li style={S.li}><strong>Buy from / Sell into</strong> — the two hubs you're comparing. Use the ⟺ button to swap.</li>
        <li style={S.li}><strong>Min margin</strong> — minimum spread percentage. Set higher to filter out marginal deals.</li>
        <li style={S.li}>Click any row to see the full breakdown and enter your freighter's cargo capacity and jump range
          to get a per-haul profit estimate.</li>
      </ul>
      <div style={S.tip}>💡 Jita → Amarr is the classic route. Check Jita → Dodixie for Gallente ship and module items —
        local buyers often pay a premium.</div>
    </Section>

    {/* ── LP Store ── */}
    <Section title="LP Store">
      <p style={S.p}>
        Loyalty Points (LP) are earned by running NPC missions. The LP Store lets you spend them on exclusive
        items — faction ships, modules, implants, and blueprints — which you then sell on the market.
        FORGE finds the redemptions with the best ISK-per-LP ratio across every NPC corporation store.
      </p>
      <ul style={S.ul}>
        <li style={S.li}>Select a faction to see its store. Items are sorted by <strong>ISK/LP</strong> — higher is better.</li>
        <li style={S.li}><strong>Can afford</strong> highlights — items where you have both enough LP and enough ISK to redeem right now.</li>
        <li style={S.li}>ISK/LP calculations use your <strong>Sell at</strong> hub price. Switch hubs to see how redemption
          value changes by market.</li>
        <li style={S.li}>Blueprint offers from LP stores are always BPCs — shown with the pale BPC icon.</li>
      </ul>
      <div style={S.tip}>💡 Faction warfare LP stores (Caldari Navy, Federation Navy, etc.) typically offer the
        best ISK/LP for popular T2 BPCs and implants. Run the numbers before redeeming anything.</div>
    </Section>

    {/* ── AI Advisor ── */}
    <Section title="AI Advisor — Getting the Most Out of It">
      <p style={S.p}>
        The <strong>Ask F.O.R.G.E. AI</strong> button opens the AI advisor. It has full access to your
        assets, blueprints, skills, wallet, active jobs, LP balances, and live market prices. It is
        specifically tuned to answer EVE manufacturing and market questions — nothing else.
      </p>
      <p style={S.p}><strong>Example prompts that work well:</strong></p>
      <span style={S.aiPrompt}>"What's the most profitable T2 module I can build right now?"</span>
      <span style={S.aiPrompt}>"I have 2 billion ISK — what should I manufacture at Jita to maximise ISK/hr?"</span>
      <span style={S.aiPrompt}>"Which of my blueprints is closest to being fully material-complete?"</span>
      <span style={S.aiPrompt}>"Compare profit for Raven vs Drake across all hubs."</span>
      <span style={S.aiPrompt}>"What LP store gives the best ISK/LP for my current balances?"</span>
      <span style={S.aiPrompt}>"Is it worth researching my Machariel BPO to ME 10?"</span>
      <span style={S.aiPrompt}>"What items should I haul from Jita to Amarr this week?"</span>
      <span style={S.aiPrompt}>"Which of my PI colonies is producing the most valuable output?"</span>

      <div style={S.tip}>💡 The AI uses your <strong>real character data</strong>. Tell it your budget,
        your available manufacturing slots, and your preferred activity (manufacturing, reactions, hauling, trading)
        for specific, actionable recommendations rather than generic advice.</div>
      <div style={S.tip}>💡 The AI only answers EVE industry and market questions. Combat, ship fittings, and
        lore are outside its scope.</div>
    </Section>

    {/* ── Managing Characters ── */}
    <Section title="Managing Multiple Characters">
      <p style={S.p}>
        Open <strong>Manage</strong> next to your character card in the left panel to add, remove, or switch
        your primary character. The window now <strong>stays open</strong> while you add characters one after
        another — it used to close after every single add (an EVE SSO login redirects the whole browser tab,
        which used to reset it), which meant reopening Manage between every alt if you run a large roster.
        Close it yourself with <strong>×</strong> or by clicking outside it whenever you're done.
      </p>

      <div style={S.tip}>💡 FORGE remembers each character's skills, so fees and build times stay correct for every character you pick
        in the <strong>True Profit</strong> drop-down. After an update, log in (or refresh) once so every character's skills are saved —
        until then the panel says the skills aren't loaded and uses untrained levels.</div>

      <div style={S.tip}>💡 Each <strong>+ Add Character</strong> click is a real EVE SSO login for that
        character — CCP's own login page, never FORGE. FORGE only ever receives a short-lived access token
        from CCP, never your password.</div>

      <p style={{ ...S.p, marginTop: 16 }}>
        <strong>🔑 Remember my characters</strong> (toggle at the top of Manage Characters) saves you from
        re-adding your whole roster every time your main logs back in:
      </p>
      <ul style={S.ul}>
        <li style={S.li}>Turn it <strong>on</strong> once, then add characters as normal — from then on, each one
          you add is remembered under your current main character.</li>
        <li style={S.li}>Next time your main logs in, FORGE shows a list of remembered characters and lets you
          pick which ones to reload — instantly, with <strong>no SSO redirect</strong> for any of them.</li>
        <li style={S.li}>You can also reload a single remembered character mid-session from Manage Characters
          any time, without waiting for the next login.</li>
        <li style={S.li}>Turning the toggle <strong>off</strong> immediately forgets every character remembered
          under that main — nothing lingers once you switch it off.</li>
        <li style={S.li}>Logging out does <em>not</em> forget your remembered characters — only the toggle or the
          per-character <strong>Forget</strong> button does.</li>
      </ul>
      <div style={S.tip}>💡 This is genuinely secure, not just "saved in the browser": FORGE stores an
        encrypted credential for each remembered character on its own server (never your password, never
        readable by FORGE staff without the encryption key), separately from the tab you're using — closing
        the browser or clearing site data doesn't lose them. Only characters <em>you</em> personally log into
        via CCP's own SSO screen can ever be remembered; FORGE has no way to add a character without that
        character's own login.</div>
      <div style={S.tip}>💡 A remembered character occasionally needs re-adding via <strong>+ Add Character</strong>
        instead of the one-click reload — shown as "Re-auth needed". This happens if EVE Online starts requiring
        a new permission FORGE didn't have when the character was first remembered, or if the character has been
        sold or transferred to a different account.</div>
    </Section>

    {/* ── Tips ── */}
    <Section title="Efficiency Tips">
      <ul style={S.ul}>
        <li style={S.li}>Log in all your industry alts with <strong>Add Character</strong> — FORGE merges blueprints,
          assets, and jobs across all of them automatically.</li>
        <li style={S.li}>Set <strong>⚙ Mfg Setup</strong> to your actual structure before reading any profit numbers.
          An Azbel with T2 ME rigs produces very different True Profit figures than an NPC station.</li>
        <li style={S.li}>The <strong>Market Opportunities</strong> table refreshes market prices automatically in the background.
          Leave FORGE open while you plan your queue — it will stay current.</li>
        <li style={S.li}>True Profit in the right panel uses your blueprint's actual ME level. If you see a worse number
          than the table estimate, your blueprint's ME is probably at 0 — research it or check your setup.</li>
        <li style={S.li}>For T2 manufacturing, always set <strong>Buy in</strong> to Jita even if you sell elsewhere —
          T2 materials (moon products, advanced components) are almost always cheapest at Jita.</li>
        <li style={S.li}>See an amber box in True Profit? It's telling you which part of the number is an assumption — usually
          materials being imported from Jita. Add your haulage costs in Mfg Setup so the freight is counted.</li>
        <li style={S.li}>To value a stockpile: Ctrl+click rows in <strong>My Assets</strong>, then hit <strong>Appraise →</strong>.
          Switch hubs instantly — C-J6MT Keepstar prices are available if you're in the Imperium.</li>
        <li style={S.li}>For null-sec loot buyback quotes: open Appraise, hit <strong>Jita Buy</strong>, set the
          percentage to your programme's rate (usually 90%), and read the cyan total. Use
          <strong> 📋 Copy as Multibuy list</strong> to hand the list to your buyer.</li>
      </ul>
    </Section>

  </div>
);

export default HelpTab;
