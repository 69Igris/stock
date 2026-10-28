/**
 * Investment Themes
 *
 * Curated collections of stocks tied to macro trends and structural shifts
 * in the Indian economy. Each theme provides a thesis, catalysts, risks,
 * and a list of constituent stocks with rationale.
 */

// ─── Types ──────────────────────────────────────────────────

export interface ThemeStock {
  symbol: string;
  name: string;
  exchange: string;
  rationale: string;
}

export interface InvestmentTheme {
  id: string;
  name: string;
  description: string;
  thesis: string;
  catalysts: string[];
  risks: string[];
  stocks: ThemeStock[];
  sector: string;
  timeframe: "short" | "medium" | "long";
  lastUpdated: string;
}

// ─── Theme Definitions ──────────────────────────────────────

export const INVESTMENT_THEMES: InvestmentTheme[] = [
  // 1. EV & Battery
  {
    id: "ev_battery",
    name: "EV & Battery",
    description:
      "Electric vehicle ecosystem including OEMs, battery manufacturers, and auto component suppliers riding the EV transition",
    thesis:
      "India's EV penetration is accelerating with government subsidies (FAME III), rising fuel costs, and falling battery prices. The domestic EV market is projected to reach $100B+ by 2030. OEMs, battery makers, and component suppliers with early EV exposure stand to benefit disproportionately.",
    catalysts: [
      "FAME III subsidy extension and expanded coverage",
      "Declining lithium-ion battery costs (below $100/kWh)",
      "State-level EV policies mandating fleet electrification",
      "Battery gigafactory investments (ACC, Amara Raja, Exide)",
      "Tightening emission norms (BS-VII roadmap)",
    ],
    risks: [
      "Slower-than-expected consumer adoption in 2W/4W segments",
      "Lithium and rare earth supply chain disruptions",
      "Chinese EV imports undercutting domestic manufacturers",
      "Charging infrastructure buildout lagging behind sales",
      "Technology risk - solid-state batteries disrupting current lithium-ion players",
    ],
    stocks: [
      {
        symbol: "TATAMOTORS",
        name: "Tata Motors",
        exchange: "NSE",
        rationale:
          "Market leader in Indian EV 4-wheelers with Nexon EV; Jaguar Land Rover electrification adds global EV exposure",
      },
      {
        symbol: "M&M",
        name: "Mahindra & Mahindra",
        exchange: "NSE",
        rationale:
          "Born Electric platform with XUV.e series; strong SUV franchise transitioning to electric",
      },
      {
        symbol: "EXIDEIND",
        name: "Exide Industries",
        exchange: "NSE",
        rationale:
          "6 GWh lithium-ion gigafactory under construction; legacy lead-acid business provides cash flow stability",
      },
      {
        symbol: "AMARAJABAT",
        name: "Amara Raja Energy & Mobility",
        exchange: "NSE",
        rationale:
          "Li-ion cell manufacturing JV with Piaggio; diversifying from lead-acid to new energy storage",
      },
      {
        symbol: "SONACOMS",
        name: "Sona BLW Precision",
        exchange: "NSE",
        rationale:
          "EV-focused auto component maker - motor controllers, differential gears used in global EV platforms",
      },
      {
        symbol: "MOTHERSON",
        name: "Motherson Sumi Wiring",
        exchange: "NSE",
        rationale:
          "Largest auto wiring harness maker; EV wiring content per vehicle is 2-3x ICE vehicles",
      },
      {
        symbol: "BOSCHLTD",
        name: "Bosch",
        exchange: "NSE",
        rationale:
          "EV powertrain components, ADAS systems, and connected mobility solutions for Indian OEMs",
      },
      {
        symbol: "MINDAIND",
        name: "Minda Industries",
        exchange: "NSE",
        rationale:
          "EV components portfolio - alloy wheels, sensors, lighting, and 4W EV systems integration",
      },
    ],
    sector: "Automobile",
    timeframe: "long",
    lastUpdated: "2026-03-01",
  },

  // 2. Green Energy
  {
    id: "green_energy",
    name: "Green Energy",
    description:
      "Renewable energy transition - solar, wind, hydro, and energy exchange players benefiting from India's net-zero 2070 commitment",
    thesis:
      "India targets 500 GW non-fossil fuel capacity by 2030 and net-zero by 2070. Renewable energy capex is running at $15B+ annually. Companies across the solar, wind, hydro, and power trading value chain are positioned for multi-decade growth as coal capacity plateaus.",
    catalysts: [
      "National Solar Mission phase extensions and tariff competitiveness",
      "Green hydrogen policy driving electrolyser demand",
      "PLI scheme for solar module and cell manufacturing",
      "Carbon credit trading framework boosting renewable ROI",
      "Declining solar and wind LCOE below coal-fired generation",
    ],
    risks: [
      "Land acquisition and grid connectivity delays",
      "Policy uncertainty on tariff revisions and subsidies",
      "Interest rate sensitivity of highly leveraged renewable IPPs",
      "Intermittency and storage costs not fully resolved",
      "Import dependency on Chinese solar modules and inverters",
    ],
    stocks: [
      {
        symbol: "ADANIGREEN",
        name: "Adani Green Energy",
        exchange: "NSE",
        rationale:
          "India's largest renewable energy IPP with 20+ GW operational pipeline; aggressive capacity addition targets",
      },
      {
        symbol: "NTPC",
        name: "NTPC",
        exchange: "NSE",
        rationale:
          "India's largest power generator pivoting to renewables; targeting 60 GW RE capacity by 2032",
      },
      {
        symbol: "TATAPOWER",
        name: "Tata Power",
        exchange: "NSE",
        rationale:
          "Vertically integrated - solar manufacturing, rooftop solar, EV charging, and utility-scale projects",
      },
      {
        symbol: "JSWENERGY",
        name: "JSW Energy",
        exchange: "NSE",
        rationale:
          "Aggressive renewable pivot with 20 GW target by 2030; diversified across solar, wind, and hydro",
      },
      {
        symbol: "SUZLON",
        name: "Suzlon Energy",
        exchange: "NSE",
        rationale:
          "India's leading wind turbine manufacturer; debt restructuring complete, strong order book recovery",
      },
      {
        symbol: "NHPC",
        name: "NHPC",
        exchange: "NSE",
        rationale:
          "India's largest hydropower generator; stable cash flows and pivoting into solar and wind projects",
      },
      {
        symbol: "SJVN",
        name: "SJVN",
        exchange: "NSE",
        rationale:
          "Diversified renewable PSU - hydro, solar, wind; 25 GW target by 2040 with government backing",
      },
      {
        symbol: "IEX",
        name: "Indian Energy Exchange",
        exchange: "NSE",
        rationale:
          "Monopoly power exchange benefiting from higher renewable trading volumes and green certificate markets",
      },
    ],
    sector: "Energy",
    timeframe: "long",
    lastUpdated: "2026-03-01",
  },

  // 3. AI & Digital India
  {
    id: "ai_digital_india",
    name: "AI & Digital India",
    description:
      "Technology companies driving India's digital transformation through AI, cloud, and IT services",
    thesis:
      "India's IT services sector is evolving from cost arbitrage to AI-driven value creation. Generative AI spending globally is growing 30%+ annually, and Indian IT firms are the primary implementation partners for Fortune 500 enterprises. Companies investing in AI platforms, LLMs, and domain-specific AI solutions will capture outsized deal wins.",
    catalysts: [
      "Enterprise GenAI adoption driving large deal pipeline acceleration",
      "India Stack expansion - UPI, ONDC, DigiLocker creating digital infrastructure",
      "Government Digital India 2.0 spending on e-governance and cloud",
      "AI/ML talent pool advantage - India produces 30% of global tech graduates",
      "Margin expansion from AI-powered delivery efficiency",
    ],
    risks: [
      "AI commoditization reducing per-deal revenue despite volume growth",
      "Currency appreciation (INR/USD) compressing export margins",
      "Tech spending cuts during global recession",
      "Talent attrition in specialized AI/ML roles",
      "Regulatory risks around AI governance and data localization",
    ],
    stocks: [
      {
        symbol: "TCS",
        name: "Tata Consultancy Services",
        exchange: "NSE",
        rationale:
          "India's largest IT company; massive enterprise AI practice and TCS Bancs platform for BFSI digitalization",
      },
      {
        symbol: "INFY",
        name: "Infosys",
        exchange: "NSE",
        rationale:
          "Topaz AI platform driving GenAI deal wins; strong positioning in cloud migration and data analytics",
      },
      {
        symbol: "HCLTECH",
        name: "HCL Technologies",
        exchange: "NSE",
        rationale:
          "AI and Cloud Native Labs; strong in engineering R&D services with high IP content",
      },
      {
        symbol: "WIPRO",
        name: "Wipro",
        exchange: "NSE",
        rationale:
          "ai360 platform with $1B AI-specific deal pipeline; focused on enterprise AI consulting",
      },
      {
        symbol: "LTIM",
        name: "LTIMindtree",
        exchange: "NSE",
        rationale:
          "Canvas.ai platform; strong in AI-powered application modernization for large enterprises",
      },
      {
        symbol: "PERSISTENT",
        name: "Persistent Systems",
        exchange: "NSE",
        rationale:
          "Product engineering DNA; AI-first delivery model with deep healthcare and BFSI expertise",
      },
      {
        symbol: "KPITTECH",
        name: "KPIT Technologies",
        exchange: "NSE",
        rationale:
          "Automotive software specialist; ADAS, autonomous driving, and connected vehicle AI stack",
      },
      {
        symbol: "COFORGE",
        name: "Coforge",
        exchange: "NSE",
        rationale:
          "AI-driven BPM and insurance tech; strong in travel and transportation vertical digitalization",
      },
    ],
    sector: "Information Technology",
    timeframe: "long",
    lastUpdated: "2026-03-01",
  },

  // 4. Defense & Aerospace
  {
    id: "defense_aerospace",
    name: "Defense & Aerospace",
    description:
      "Indigenous defense manufacturing companies benefiting from Atmanirbhar Bharat and rising defense budgets",
    thesis:
      "India is the world's largest arms importer, spending $75B+ annually on defense. The government's push for indigenous manufacturing (Make in India Defense) with import bans on 500+ items, combined with growing export orders, creates a structural multi-decade growth runway for domestic defense companies.",
    catalysts: [
      "Defense budget allocation increasing to 3%+ of GDP",
      "Positive indigenization lists banning import of 500+ defense items",
      "Growing defense export orders ($3B+ annually, targeting $5B by 2028)",
      "Private sector entry into defense manufacturing via licensing reforms",
      "Tejas MK2, Brahmos, and advanced missile program orders ramping up",
    ],
    risks: [
      "Order execution delays due to bureaucratic procurement processes",
      "Geopolitical de-escalation reducing urgency of defense spending",
      "Technology transfer challenges with advanced platforms",
      "Working capital intensity from long payment cycles",
      "Concentration risk - few large buyers (Indian MOD)",
    ],
    stocks: [
      {
        symbol: "HAL",
        name: "Hindustan Aeronautics",
        exchange: "NSE",
        rationale:
          "India's sole fighter jet manufacturer; Tejas MK1A/MK2 orders worth 1.5 lakh crore; helicopter and engine programs",
      },
      {
        symbol: "BEL",
        name: "Bharat Electronics",
        exchange: "NSE",
        rationale:
          "Electronic warfare, radar, and communication systems; diversifying into non-defense segments like smart cities",
      },
      {
        symbol: "BHARATDYN",
        name: "Bharat Dynamics",
        exchange: "NSE",
        rationale:
          "India's missile manufacturer - Akash, QRSAM, Astra; export orders from friendly nations growing",
      },
      {
        symbol: "BEML",
        name: "BEML",
        exchange: "NSE",
        rationale:
          "Defense vehicles, metro coaches, and mining equipment; potential privatization candidate",
      },
      {
        symbol: "MAZDOCK",
        name: "Mazagon Dock Shipbuilders",
        exchange: "NSE",
        rationale:
          "India's premier warship builder - submarines (Scorpene class) and destroyers for Indian Navy",
      },
      {
        symbol: "COCHINSHIP",
        name: "Cochin Shipyard",
        exchange: "NSE",
        rationale:
          "India's largest shipyard; indigenous aircraft carrier builder; ship repair and commercial shipbuilding",
      },
      {
        symbol: "PARAS",
        name: "Paras Defence and Space Technologies",
        exchange: "NSE",
        rationale:
          "Niche defense electronics - optics, defense EW systems, and space-grade components",
      },
      {
        symbol: "DATAPATTNS",
        name: "Data Patterns (India)",
        exchange: "NSE",
        rationale:
          "Indigenous defense electronics - radar sub-systems, missile guidance, and satellite systems for ISRO/DRDO",
      },
    ],
    sector: "Defense",
    timeframe: "long",
    lastUpdated: "2026-03-01",
  },

  // 5. PLI Beneficiaries
  {
    id: "pli_beneficiaries",
    name: "PLI Beneficiaries",
    description:
      "Companies benefiting from Production Linked Incentive schemes across electronics, semiconductors, and manufacturing",
    thesis:
      "India's PLI scheme allocates Rs 1.97 lakh crore across 14 sectors to boost domestic manufacturing. Electronics manufacturing services (EMS) companies are the biggest beneficiaries, with mobile phone exports already crossing $10B. As semiconductor fabs come online and component ecosystems mature, PLI beneficiaries will see sustained revenue growth.",
    catalysts: [
      "PLI disbursements accelerating across electronics and telecom",
      "Apple, Samsung, and Foxconn expanding India manufacturing capacity",
      "Semiconductor fab construction (Tata-PSMC, CG Power) beginning production",
      "Component localization driving higher value addition per unit",
      "Export incentive alignment making India competitive vs Vietnam and China",
    ],
    risks: [
      "PLI scheme expiry without extension reducing incentive advantage",
      "Scale disadvantage vs China's established supply chains",
      "Component import dependency creating margin pressure on INR weakness",
      "Execution risk on greenfield semiconductor fabs",
      "Customer concentration risk with few large OEM clients",
    ],
    stocks: [
      {
        symbol: "DIXON",
        name: "Dixon Technologies",
        exchange: "NSE",
        rationale:
          "India's largest EMS company; PLI beneficiary across mobiles, TVs, lighting, and wearables manufacturing",
      },
      {
        symbol: "AMBER",
        name: "Amber Enterprises",
        exchange: "NSE",
        rationale:
          "India's largest RAC ODM; expanding into electronics EMS - PCBAs, motors, and railway sub-systems",
      },
      {
        symbol: "SYRMA",
        name: "Syrma SGS Technology",
        exchange: "NSE",
        rationale:
          "PCBA and IoT device manufacturing; strong in automotive electronics and smart meters under PLI",
      },
      {
        symbol: "KAYNES",
        name: "Kaynes Technology India",
        exchange: "NSE",
        rationale:
          "High-complexity PCBA - aerospace, defense, automotive, and industrial IoT; OSAT assembly planned",
      },
      {
        symbol: "TATAELXSI",
        name: "Tata Elxsi",
        exchange: "NSE",
        rationale:
          "Design-led digital engineering; automotive ADAS, media, and healthcare tech - proxy for Tata Group's electronics push",
      },
      {
        symbol: "VEDL",
        name: "Vedanta",
        exchange: "NSE",
        rationale:
          "Semiconductor fab partnership with Foxconn; display glass manufacturing under PLI for IT hardware",
      },
    ],
    sector: "Manufacturing",
    timeframe: "medium",
    lastUpdated: "2026-03-01",
  },

  // 6. China+1
  {
    id: "china_plus_one",
    name: "China+1",
    description:
      "Indian manufacturers gaining market share as global supply chains diversify away from China",
    thesis:
      "Post-COVID supply chain realignment and geopolitical tensions are driving global companies to diversify manufacturing away from China. India's labor cost advantage, improving infrastructure, and PLI incentives make it the primary alternative. Companies in electronics, cables, pipes, and consumer durables with export capabilities are direct beneficiaries.",
    catalysts: [
      "US-China trade tensions escalating tariffs on Chinese goods",
      "European and Japanese companies actively seeking India-based suppliers",
      "India's manufacturing PMI consistently above 55 indicating expansion",
      "Free trade agreements (FTAs) with UK, EU under negotiation",
      "Quality certifications (UL, CE, BIS) adoption improving export readiness",
    ],
    risks: [
      "India's infrastructure bottlenecks (logistics cost 13% of GDP vs 8% global average)",
      "Labor law complexity and skill gaps in precision manufacturing",
      "Vietnam and Indonesia competing for the same China+1 flows",
      "Rupee appreciation eroding export competitiveness",
      "Raw material price volatility impacting margins",
    ],
    stocks: [
      {
        symbol: "DIXON",
        name: "Dixon Technologies",
        exchange: "NSE",
        rationale:
          "Primary India EMS partner for global brands shifting phone and TV manufacturing from China",
      },
      {
        symbol: "AMBER",
        name: "Amber Enterprises",
        exchange: "NSE",
        rationale:
          "AC and electronics ODM capturing share as Japanese and Korean brands reduce China sourcing",
      },
      {
        symbol: "APLAPOLLO",
        name: "APL Apollo Tubes",
        exchange: "NSE",
        rationale:
          "India's largest structural steel tube maker; import substitution from Chinese steel products",
      },
      {
        symbol: "POLYCAB",
        name: "Polycab India",
        exchange: "NSE",
        rationale:
          "Cable and wire leader with growing exports; beneficiary of electrical infrastructure import substitution",
      },
      {
        symbol: "HAVELLS",
        name: "Havells India",
        exchange: "NSE",
        rationale:
          "Consumer electrical brand with backward integration; capturing market share from Chinese lighting and switch imports",
      },
      {
        symbol: "VGUARD",
        name: "V-Guard Industries",
        exchange: "NSE",
        rationale:
          "South India electrical brand expanding nationally; beneficiary of domestic manufacturing preference for stabilizers and pumps",
      },
    ],
    sector: "Manufacturing",
    timeframe: "medium",
    lastUpdated: "2026-03-01",
  },

  // 7. India Infrastructure
  {
    id: "india_infrastructure",
    name: "India Infrastructure",
    description:
      "Roads, railways, ports, and cement companies riding India's $1.4 trillion National Infrastructure Pipeline",
    thesis:
      "India's National Infrastructure Pipeline targets $1.4 trillion spend by 2025, with continued acceleration beyond. Record highway construction (12,000+ km/year), dedicated freight corridors, port modernization (Sagarmala), and smart cities are driving sustained demand for construction and building material companies.",
    catalysts: [
      "National Infrastructure Pipeline budget allocation increasing annually",
      "Bharatmala/Sagarmala highway and port projects in execution phase",
      "Dedicated freight corridors boosting rail infrastructure spend",
      "Smart Cities Mission Phase 2 driving urban infrastructure",
      "Cement demand growing 7-8% annually on housing + infra boom",
    ],
    risks: [
      "Government fiscal deficit constraints slowing project awards",
      "Land acquisition delays impacting project execution timelines",
      "Rising raw material costs (steel, cement, bitumen) squeezing contractor margins",
      "Election cycle causing temporary policy paralysis on new awards",
      "Working capital stress for mid-tier contractors with long payment cycles",
    ],
    stocks: [
      {
        symbol: "LT",
        name: "Larsen & Toubro",
        exchange: "NSE",
        rationale:
          "India's largest infra EPC; diversified across roads, metros, defense, and water projects with $50B+ order book",
      },
      {
        symbol: "ULTRACEMCO",
        name: "UltraTech Cement",
        exchange: "NSE",
        rationale:
          "India's largest cement manufacturer with 130+ MTPA capacity; direct proxy for construction demand",
      },
      {
        symbol: "ACC",
        name: "ACC",
        exchange: "NSE",
        rationale:
          "Adani Group cement company with pan-India presence; capacity expansion and cost optimization driving growth",
      },
      {
        symbol: "AMBUJACEM",
        name: "Ambuja Cements",
        exchange: "NSE",
        rationale:
          "Adani Group cement arm with strong western India presence; clinker expansion boosting margins",
      },
      {
        symbol: "KNRCON",
        name: "KNR Constructions",
        exchange: "NSE",
        rationale:
          "Asset-light road EPC with best-in-class execution track record; strong order book to revenue ratio",
      },
      {
        symbol: "PNCINFRA",
        name: "PNC Infratech",
        exchange: "NSE",
        rationale:
          "Road and highway construction specialist; HAM project portfolio providing annuity cash flows",
      },
      {
        symbol: "IRB",
        name: "IRB Infrastructure Developers",
        exchange: "NSE",
        rationale:
          "India's largest private toll road operator; BOT/TOT portfolio generating stable toll revenues",
      },
      {
        symbol: "IRCON",
        name: "IRCON International",
        exchange: "NSE",
        rationale:
          "PSU railway construction company; order book driven by dedicated freight corridors and station redevelopment",
      },
    ],
    sector: "Infrastructure",
    timeframe: "long",
    lastUpdated: "2026-03-01",
  },

  // 8. Digital Payments & Fintech
  {
    id: "digital_payments_fintech",
    name: "Digital Payments & Fintech",
    description:
      "Companies powering India's cashless economy - payments, capital market infrastructure, and insurtech",
    thesis:
      "UPI processes 12B+ transactions monthly and is growing 40%+ YoY. India's digital payment volume will reach $1 trillion by 2027. Companies enabling payment rails, capital market infrastructure (depositories, exchanges), and financial product distribution are beneficiaries of irreversible digitalization of money.",
    catalysts: [
      "UPI international expansion (Singapore, UAE, France) driving cross-border volumes",
      "Credit on UPI launch creating a massive new lending channel",
      "SEBI reforms expanding retail participation in capital markets",
      "ONDC integration enabling open network commerce with embedded payments",
      "Insurance penetration rising from 4% to global average of 7%",
    ],
    risks: [
      "Zero MDR on UPI limiting monetization for payment companies",
      "Regulatory changes in interchange fees or lending norms",
      "Market downturn reducing capital market volumes and IPO pipeline",
      "Fintech burn rates and path to profitability uncertainty",
      "Cyber security risks and data breach liabilities",
    ],
    stocks: [
      {
        symbol: "PAYTM",
        name: "One 97 Communications (Paytm)",
        exchange: "NSE",
        rationale:
          "India's largest fintech ecosystem - payments, lending, insurance, and wealth; turnaround to profitability underway",
      },
      {
        symbol: "POLICYBZR",
        name: "PB Fintech (PolicyBazaar)",
        exchange: "NSE",
        rationale:
          "India's largest online insurance aggregator; expanding into health services and credit with path to profitability",
      },
      {
        symbol: "CAMS",
        name: "Computer Age Management Services",
        exchange: "NSE",
        rationale:
          "Duopoly in mutual fund RTA services; beneficiary of every rupee flowing into Indian mutual funds",
      },
      {
        symbol: "CDSL",
        name: "Central Depository Services",
        exchange: "NSE",
        rationale:
          "Dominant depository with 12Cr+ demat accounts; annuity revenue from annual charges and transaction fees",
      },
      {
        symbol: "BSE",
        name: "BSE",
        exchange: "NSE",
        rationale:
          "India's oldest stock exchange; options volume surge and StAR MF platform driving revenue growth",
      },
      {
        symbol: "MCX",
        name: "Multi Commodity Exchange",
        exchange: "NSE",
        rationale:
          "India's largest commodity exchange; technology migration complete, options volumes accelerating",
      },
      {
        symbol: "SBICARD",
        name: "SBI Cards & Payment Services",
        exchange: "NSE",
        rationale:
          "India's largest pure-play credit card issuer; rising credit penetration and spend per card driving growth",
      },
    ],
    sector: "Financial Services",
    timeframe: "medium",
    lastUpdated: "2026-03-01",
  },

  // 9. Healthcare & Pharma
  {
    id: "healthcare_pharma",
    name: "Healthcare & Pharma",
    description:
      "Pharmaceutical and hospital companies with domestic growth and global generic/CDMO export opportunities",
    thesis:
      "India is the 'pharmacy of the world' supplying 20% of global generic drugs. Domestic healthcare spend is rising with Ayushman Bharat coverage expansion, while CDMO/biosimilar exports provide a second growth engine. Hospital chains benefit from rising health insurance penetration and medical tourism.",
    catalysts: [
      "US generic drug pricing stabilization improving export margins",
      "Biosimilar approvals in US/EU opening large revenue pools",
      "CDMO demand surge as global pharma outsources manufacturing",
      "Ayushman Bharat expansion driving domestic drug consumption",
      "Medical tourism to India growing 20%+ annually",
    ],
    risks: [
      "USFDA compliance issues leading to import alerts and warning letters",
      "Drug pricing controls (DPCO) compressing domestic margins",
      "Patent cliff competition intensifying in key generic molecules",
      "API import dependency on China for key starting materials",
      "Healthcare regulatory changes in key export markets",
    ],
    stocks: [
      {
        symbol: "SUNPHARMA",
        name: "Sun Pharmaceutical Industries",
        exchange: "NSE",
        rationale:
          "India's largest pharma company; specialty portfolio (Ilumya, Winlevi) and strong US/India branded generics",
      },
      {
        symbol: "DRREDDY",
        name: "Dr. Reddy's Laboratories",
        exchange: "NSE",
        rationale:
          "Diversified global generics with strong biosimilar pipeline; US gRevlimid opportunity adds meaningful revenue",
      },
      {
        symbol: "CIPLA",
        name: "Cipla",
        exchange: "NSE",
        rationale:
          "Respiratory and complex generics leader; strong India branded business and growing US peptide pipeline",
      },
      {
        symbol: "DIVISLAB",
        name: "Divi's Laboratories",
        exchange: "NSE",
        rationale:
          "India's premier CDMO/API company; custom synthesis for global innovators with high margins and asset efficiency",
      },
      {
        symbol: "LAURUSLABS",
        name: "Laurus Labs",
        exchange: "NSE",
        rationale:
          "Integrated CDMO with ARV, oncology, and synthesis platforms; capacity expansion for crop science diversification",
      },
      {
        symbol: "GLAND",
        name: "Gland Pharma",
        exchange: "NSE",
        rationale:
          "Injectable specialist with US B2B ANDA portfolio; Shanghai Fosun backing provides China market access",
      },
      {
        symbol: "MAXHEALTH",
        name: "Max Healthcare Institute",
        exchange: "NSE",
        rationale:
          "Premium hospital chain with highest EBITDA margins in the sector; bed expansion driving revenue growth",
      },
      {
        symbol: "APOLLOHOSP",
        name: "Apollo Hospitals Enterprise",
        exchange: "NSE",
        rationale:
          "India's largest hospital chain; omni-channel healthcare - hospitals, pharmacy, diagnostics, and Apollo 24|7 digital health",
      },
    ],
    sector: "Healthcare",
    timeframe: "long",
    lastUpdated: "2026-03-01",
  },

  // 10. Real Estate Revival
  {
    id: "real_estate_revival",
    name: "Real Estate Revival",
    description:
      "Listed real estate developers and REITs benefiting from the housing upcycle and commercial demand",
    thesis:
      "India's residential real estate is in a structural upcycle driven by low inventory (16-18 month supply vs 42 months in 2016), rising incomes, and preference for branded developers post-RERA. Commercial real estate demand is driven by GCC/office expansion. Listed developers with strong balance sheets and land banks are gaining market share from unorganized players.",
    catalysts: [
      "Residential inventory at decade-low levels pushing price appreciation",
      "RERA implementation consolidating market share to organized developers",
      "Stamp duty rationalizations in key states boosting registrations",
      "Office space demand from GCCs and flex operators at record highs",
      "Home loan rates stabilizing with RBI rate cuts expected",
    ],
    risks: [
      "Interest rate hikes making home loans expensive and slowing demand",
      "Regulatory delays in project approvals and land title disputes",
      "Input cost inflation (steel, cement, labor) compressing margins",
      "Oversupply risk in specific micro-markets",
      "Policy changes (capital gains tax, GST on under-construction) impacting sentiment",
    ],
    stocks: [
      {
        symbol: "DLF",
        name: "DLF",
        exchange: "NSE",
        rationale:
          "India's largest listed developer; luxury residential sales at record highs and rental income from DLF Cyber City REIT",
      },
      {
        symbol: "GODREJPROP",
        name: "Godrej Properties",
        exchange: "NSE",
        rationale:
          "Asset-light developer with pan-India presence; strong brand driving record new launch sales bookings",
      },
      {
        symbol: "OBEROIRLTY",
        name: "Oberoi Realty",
        exchange: "NSE",
        rationale:
          "Premium Mumbai developer with best-in-class margins; integrated luxury residential and commercial projects",
      },
      {
        symbol: "PRESTIGE",
        name: "Prestige Estates Projects",
        exchange: "NSE",
        rationale:
          "Diversified South India developer; Blackstone partnership in commercial and rapid expansion into Mumbai/NCR",
      },
      {
        symbol: "BRIGADE",
        name: "Brigade Enterprises",
        exchange: "NSE",
        rationale:
          "Bangalore-focused developer with commercial annuity assets (WTC, malls); beneficiary of tech capital's office demand",
      },
      {
        symbol: "SOBHA",
        name: "Sobha",
        exchange: "NSE",
        rationale:
          "Backward-integrated developer with own construction capability; strong Bangalore residential franchise",
      },
      {
        symbol: "PHOENIXLTD",
        name: "Phoenix Mills",
        exchange: "NSE",
        rationale:
          "India's premium mall operator; High Street Phoenix and expansion pipeline driving retail rental income growth",
      },
    ],
    sector: "Real Estate",
    timeframe: "medium",
    lastUpdated: "2026-03-01",
  },

  // 11. Rural & Agri
  {
    id: "rural_agri",
    name: "Rural & Agri",
    description:
      "Agrochemicals, fertilizers, and FMCG companies benefiting from rising farm incomes and rural consumption",
    thesis:
      "India's rural economy is 46% of GDP, and farm income growth drives a massive consumption cycle. Good monsoons, higher MSPs (minimum support prices), and government PM-KISAN transfers are boosting rural purchasing power. Agrochemical companies benefit from crop protection demand, while FMCG companies see volume recovery in rural channels.",
    catalysts: [
      "Normal/above-normal monsoon forecasts boosting kharif output",
      "MSP hikes of 5-7% annually supporting farm income growth",
      "PM-KISAN and rural employment schemes boosting disposable income",
      "Export demand recovery for Indian agrochemicals (global destocking over)",
      "Precision agriculture and biotech crop adoption increasing input spend",
    ],
    risks: [
      "Erratic monsoon patterns (El Nino/La Nina) disrupting crop output",
      "Regulatory bans on specific pesticide molecules",
      "Chinese agrochemical dumping depressing pricing",
      "Fertilizer subsidy rationalization increasing farmer input costs",
      "Commodity price deflation reducing farmer margins and spend capacity",
    ],
    stocks: [
      {
        symbol: "UPL",
        name: "UPL",
        exchange: "NSE",
        rationale:
          "Global top-5 agrochemical company; post-acquisition integration complete, biosolutions growing fast",
      },
      {
        symbol: "PIIND",
        name: "PI Industries",
        exchange: "NSE",
        rationale:
          "CSM (custom synthesis) exports leader; strong in-licensed product pipeline for domestic branded agrochemicals",
      },
      {
        symbol: "DHANUKA",
        name: "Dhanuka Agritech",
        exchange: "NSE",
        rationale:
          "Domestic agrochemical brand with strong rural distribution; in-licensed products from global innovators",
      },
      {
        symbol: "RALLIS",
        name: "Rallis India",
        exchange: "NSE",
        rationale:
          "Tata Group agrochemical arm; domestic formulations and seeds business with contract manufacturing exports",
      },
      {
        symbol: "CHAMBLFERT",
        name: "Chambal Fertilisers & Chemicals",
        exchange: "NSE",
        rationale:
          "India's largest private urea manufacturer; stable volumes with government subsidy ensuring offtake",
      },
      {
        symbol: "GODREJAGRO",
        name: "Godrej Agrovet",
        exchange: "NSE",
        rationale:
          "Diversified agri company - animal feed, crop protection, palm oil, and dairy; rural consumption proxy",
      },
      {
        symbol: "TATACONSUM",
        name: "Tata Consumer Products",
        exchange: "NSE",
        rationale:
          "Tea, salt, and staples leader; Tata Sampann and Starbucks JV; rural distribution expansion driving growth",
      },
      {
        symbol: "DABUR",
        name: "Dabur India",
        exchange: "NSE",
        rationale:
          "Ayurvedic and natural products FMCG; highest rural revenue mix (~45%) among large FMCG companies",
      },
    ],
    sector: "Agriculture",
    timeframe: "medium",
    lastUpdated: "2026-03-01",
  },

  // 12. CPSE Privatization
  {
    id: "cpse_privatization",
    name: "CPSE Privatization",
    description:
      "Central Public Sector Enterprises targeted for disinvestment or strategic sale, offering re-rating potential",
    thesis:
      "Government of India is committed to reducing its stake in non-strategic CPSEs to raise resources and improve operational efficiency. Strategic sales (like Air India, BPCL) and OFS-driven disinvestment unlock value by improving corporate governance, reducing bureaucratic inefficiency, and attracting strategic investors. CPSEs trade at significant discounts to private peers.",
    catalysts: [
      "Government disinvestment target of Rs 50,000+ crore annually",
      "Strategic sale announcements for shortlisted companies",
      "Listing of PSU subsidiaries (LIC, IREDA model) unlocking holding company value",
      "Improvement in dividend payout ratios under DIPAM guidelines",
      "Board professionalization and operational efficiency improvements post-privatization",
    ],
    risks: [
      "Political resistance delaying privatization of large CPSEs",
      "Election cycles causing temporary halt in disinvestment activity",
      "Market conditions unfavorable for OFS pricing",
      "Regulatory uncertainty on sector-specific privatization (banking, mining)",
      "Labor union opposition impacting post-privatization restructuring",
    ],
    stocks: [
      {
        symbol: "BPCL",
        name: "Bharat Petroleum Corporation",
        exchange: "NSE",
        rationale:
          "Perennial privatization candidate; strategic sale would unlock massive value in refining and fuel retail assets",
      },
      {
        symbol: "CONCOR",
        name: "Container Corporation of India",
        exchange: "NSE",
        rationale:
          "Rail logistics monopoly; government reducing stake with strategic buyer to improve operational efficiency",
      },
      {
        symbol: "IDBI",
        name: "IDBI Bank",
        exchange: "NSE",
        rationale:
          "LIC + GOI stake sale in progress; private acquisition would drive re-rating to private bank multiples",
      },
      {
        symbol: "SCI",
        name: "Shipping Corporation of India",
        exchange: "NSE",
        rationale:
          "Strategic disinvestment candidate; fleet modernization and trade growth make it attractive for acquirers",
      },
      {
        symbol: "NMDC",
        name: "NMDC",
        exchange: "NSE",
        rationale:
          "India's largest iron ore miner; trades at deep discount to global peers; potential value unlock via stake sale",
      },
      {
        symbol: "SAIL",
        name: "Steel Authority of India",
        exchange: "NSE",
        rationale:
          "India's largest steel PSU; capacity modernization complete, re-rating potential if government reduces stake",
      },
      {
        symbol: "HUDCO",
        name: "Housing & Urban Development Corporation",
        exchange: "NSE",
        rationale:
          "Government housing finance arm; beneficiary of PMAY urban/rural schemes with growing loan book",
      },
    ],
    sector: "Diversified",
    timeframe: "medium",
    lastUpdated: "2026-03-01",
  },
];

// ─── Lookup Functions ───────────────────────────────────────

/**
 * Returns all curated investment themes.
 */
export function getAllThemes(): InvestmentTheme[] {
  return INVESTMENT_THEMES;
}

/**
 * Returns a single theme by its id.
 */
export function getThemeById(id: string): InvestmentTheme | undefined {
  return INVESTMENT_THEMES.find((t) => t.id === id);
}

/**
 * Searches themes by query matching against name, description, thesis,
 * sector, stock names, and stock symbols.
 */
export function searchThemes(query: string): InvestmentTheme[] {
  const q = query.toLowerCase();
  return INVESTMENT_THEMES.filter(
    (t) =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.thesis.toLowerCase().includes(q) ||
      t.sector.toLowerCase().includes(q) ||
      t.stocks.some(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.symbol.toLowerCase().includes(q),
      ),
  );
}

/**
 * Returns themes filtered by timeframe.
 */
export function getThemesByTimeframe(
  timeframe: "short" | "medium" | "long",
): InvestmentTheme[] {
  return INVESTMENT_THEMES.filter((t) => t.timeframe === timeframe);
}
