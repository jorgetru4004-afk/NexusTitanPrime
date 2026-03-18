'use strict';
// ╔══════════════════════════════════════════════════════════════════╗
// ║   NEXUS TITAN PRIME — Large Cap Momentum Specialist              ║
// ║   SPY · QQQ · Mag7 · Sector Leaders · Institutional Flow         ║
// ║   Macro-Aware · Earnings Intelligence · Options Flow             ║
// ║   Built Once — Built Permanently — No Ceiling Ever               ║
// ╚══════════════════════════════════════════════════════════════════╝

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static(__dirname));

// ── CONFIG ──
const PORT = process.env.PORT || 8080;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
const ALPACA_KEY = process.env.ALPACA_KEY || process.env.APCA_API_KEY_ID || '';
const ALPACA_SECRET = process.env.ALPACA_SECRET || process.env.APCA_API_SECRET_KEY || '';
const ALPACA_BASE = 'https://paper-api.alpaca.markets';
const ALPACA_DATA = 'https://data.alpaca.markets';
const MODEL = 'claude-sonnet-4-6';
const IS_PAPER = true;

// ── PRIME UNIVERSE — Large caps and sector leaders only ──
const PRIME_UNIVERSE = [
  // Magnificent 7
  'NVDA', 'MSFT', 'AAPL', 'GOOGL', 'META', 'AMZN', 'TSLA',
  // Market ETFs
  'SPY', 'QQQ', 'IWM', 'DIA',
  // Sector leaders
  'AMD', 'AVGO', 'CRM', 'ORCL', 'NFLX', 'UBER', 'COIN',
  // Financials
  'JPM', 'GS', 'MS',
  // Energy / Macro
  'XOM', 'GLD', 'TLT',
  // AI / Semiconductor
  'ARM', 'SMCI', 'PLTR', 'MSTR'
];

// ── SETTINGS ──
const SETTINGS = {
  maxPositions: 3,           // Large caps need more capital per position
  heatCeiling: 0.60,         // Can run hotter — large caps are more liquid
  dailyLossLimit: 800,       // Higher loss tolerance for larger moves
  minConfidence: 65,         // Higher bar — large caps need stronger conviction
  scanInterval: 15 * 60 * 1000,  // 15 min — large caps move slower
  exitCheckInterval: 5 * 60 * 1000,
  peakProtection: 0.25,      // Give more room — large caps trend longer
  minMoveThreshold: 2.0,     // 2% minimum move to consider
  minVolMultiple: 1.3,       // Lower bar — large caps always have volume
  stagedEntry: true,
  maxPositionPct: 0.20,      // Max 20% of budget per position
  macroAware: true,          // Considers Fed, CPI, macro events
  earningsWindow: true,      // Tracks earnings calendars
};

// ── PERSISTENCE ──
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return fb; } }
function saveJSON(f, d) { try { fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(d, null, 2)); } catch (e) {} }

// ── STATE ──
const saved = loadJSON('state.json', {});
let marketRegime = saved.marketRegime || 'RANGING';
let spyChange = 0;
let spyTrend = 'NEUTRAL'; // 5-day trend
let vixLevel = saved.vixLevel || 20;
let personality = saved.personality || 'PRIME_HUNTER';
let totalPnl = saved.totalPnl || 0;
let totalTrades = saved.totalTrades || 0;
let totalWins = saved.totalWins || 0;
let dailyPnl = saved.dailyPnl || 0;
let dailyLoss = saved.dailyLoss || 0;
let dailyTrades = saved.dailyTrades || 0;
let weeklyPnl = saved.weeklyPnl || 0;
let allTimePeak = saved.allTimePeak || 0;
let consecutiveWins = saved.consecutiveWins || 0;
let consecutiveLoss = saved.consecutiveLoss || 0;
let portfolioHeat = 0;
let paused = false;
let pauseReason = '';
let lastScanTime = null;
let macroContext = loadJSON('macro.json', { events: [], lastUpdated: null, fedStance: 'NEUTRAL', inflationTrend: 'UNKNOWN' });
let sectorRotation = loadJSON('sectors.json', { leading: [], lagging: [], lastUpdated: null });

let positions = loadJSON('positions.json', {});
let candidates = [];
let rotationLog = [];
let alerts = [];
let tradeJournal = loadJSON('trades.json', []);
let learning = loadJSON('learning.json', {
  totalDecisions: 0, tickerWR: {}, patternWR: {}, regimeWR: {},
  macroWR: {}, timeWR: {}, bestTicker: null, lastOptimized: null
});

let ai1Dec = {}, ai2Dec = {}, ai3Dec = {}, ai4Dec = {}, ai5Dec = {}, ai6Dec = {};

function saveState() {
  saveJSON('state.json', { marketRegime, spyChange, vixLevel, personality, totalPnl, totalTrades, totalWins, dailyPnl, weeklyPnl, allTimePeak, consecutiveWins, consecutiveLoss, lastUpdated: new Date().toISOString() });
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch (e) {} });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getSnapshot() {
  return {
    SETTINGS, personality, marketRegime, spyChange, spyTrend, vixLevel,
    paused, pauseReason, totalPnl, totalTrades, totalWins, dailyPnl,
    weeklyPnl, allTimePeak, dailyTrades, dailyLoss, portfolioHeat,
    positions, candidates, rotationLog: rotationLog.slice(0, 30),
    alerts: alerts.slice(0, 30), ai1Dec, ai2Dec, ai3Dec, ai4Dec, ai5Dec, ai6Dec,
    learning, tradeJournal: tradeJournal.slice(0, 100),
    lastScanTime, macroContext, sectorRotation,
    openPnl: Object.values(positions).reduce((s, p) => s + (p.unrealizedPnl || 0), 0),
    winRate: totalTrades > 0 ? parseFloat((totalWins / totalTrades * 100).toFixed(1)) : 0,
    serverTime: new Date().toISOString()
  };
}

// ══════════════════════════════════════════════════════
// ALPACA DATA LAYER
// ══════════════════════════════════════════════════════
const alpacaHeaders = () => ({
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json'
});

async function getSnapshot_stock(ticker) {
  try {
    const resp = await axios.get(`${ALPACA_DATA}/v2/stocks/${ticker}/snapshot`, {
      headers: alpacaHeaders(), timeout: 6000
    });
    const d = resp.data;
    const price = d?.latestTrade?.p || d?.minuteBar?.c || 0;
    const prevClose = d?.prevDailyBar?.c || price;
    const vol = d?.dailyBar?.v || 0;
    const avgVol = d?.prevDailyBar?.v || vol;
    return {
      price, change: prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0,
      volume: vol, avgVolume: avgVol,
      volMultiple: avgVol > 0 ? parseFloat((vol / avgVol).toFixed(2)) : 1,
      high: d?.dailyBar?.h || price, low: d?.dailyBar?.l || price,
      open: d?.dailyBar?.o || price, prevClose,
      type: 'LARGE_CAP'
    };
  } catch (e) { return null; }
}

async function getMultiSnapshot(tickers) {
  try {
    const resp = await axios.get(`${ALPACA_DATA}/v2/stocks/snapshots?symbols=${tickers.join(',')}`, {
      headers: alpacaHeaders(), timeout: 10000
    });
    const result = {};
    for (const [sym, d] of Object.entries(resp.data || {})) {
      const price = d?.latestTrade?.p || d?.minuteBar?.c || 0;
      const prevClose = d?.prevDailyBar?.c || price;
      const vol = d?.dailyBar?.v || 0;
      const avgVol = d?.prevDailyBar?.v || vol;
      result[sym] = {
        price, change: prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0,
        volume: vol, avgVolume: avgVol,
        volMultiple: avgVol > 0 ? parseFloat((vol / avgVol).toFixed(2)) : 1,
        high: d?.dailyBar?.h || price, low: d?.dailyBar?.l || price,
        open: d?.dailyBar?.o || price, prevClose, type: 'LARGE_CAP'
      };
    }
    return result;
  } catch (e) { return {}; }
}

async function getSPYData() {
  try {
    // Try latest bar first for fresher data (works better pre-market)
    const resp = await axios.get(`${ALPACA_DATA}/v2/stocks/SPY/bars/latest`, {
      headers: alpacaHeaders(), timeout: 6000
    });
    const bar = resp.data?.bar;
    if (bar && bar.c) {
      // Also get prev close via snapshot
      const snap = await getSnapshot_stock('SPY');
      if (snap && snap.prevClose > 0) {
        spyChange = parseFloat(((bar.c - snap.prevClose) / snap.prevClose * 100).toFixed(2));
      } else {
        spyChange = snap?.change || 0;
      }
    } else {
      const snap = await getSnapshot_stock('SPY');
      if (snap) spyChange = snap.change;
    }
    marketRegime = spyChange > 1.0 ? 'BULL_TRENDING' : spyChange > 0.2 ? 'BULL_RANGING' :
      spyChange < -1.0 ? 'BEAR_TRENDING' : spyChange < -0.2 ? 'BEAR_RANGING' : 'RANGING';
    console.log(`📈 SPY: ${spyChange >= 0 ? '+' : ''}${spyChange}% | ${marketRegime}`);
  } catch (e) {
    // Fallback to snapshot
    try {
      const snap = await getSnapshot_stock('SPY');
      if (snap) { spyChange = snap.change; marketRegime = spyChange > 0.2 ? 'BULL_RANGING' : spyChange < -0.2 ? 'BEAR_RANGING' : 'RANGING'; }
    } catch (e2) {}
  }
}

async function placeOrder(ticker, qty, side) {
  if (!ALPACA_KEY || qty <= 0) return null;
  try {
    const body = { symbol: ticker, qty: Math.floor(qty), side, type: 'market', time_in_force: 'day' };
    const resp = await axios.post(`${ALPACA_BASE}/v2/orders`, body, { headers: alpacaHeaders(), timeout: 10000 });
    console.log(`📋 TITAN PRIME ${side} ${qty}x ${ticker}`);
    return resp.data;
  } catch (e) {
    console.error(`Order error ${ticker}:`, e.response?.data?.message || e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════
// PRE-LOADED PRIME INTELLIGENCE
// ══════════════════════════════════════════════════════
const PRIME_KNOWLEDGE = `
TITAN PRIME — LARGE CAP INTELLIGENCE:

MAGNIFICENT 7 BEHAVIOR PATTERNS:
- NVDA: AI infrastructure narrative leader. Earnings moves +/-15%. Options pinning common. Runs 3-5 days after positive catalyst. Short squeezes rare but violent.
- MSFT: Steady institutional accumulation. Cloud Azure growth = stock growth. Less volatile than peers. Options flow very predictive.
- AAPL: Consumer sentiment proxy. iPhone cycle drives quarterly moves. Services growth now primary narrative. Buybacks provide floor.
- GOOGL: Ad revenue + AI race (Gemini). Earnings surprises create 5-8% single day moves. Lower beta than NVDA.
- META: Ad revenue acceleration. Reality Labs drag known. Efficiency narrative drives multiple expansion. Strong momentum player.
- AMZN: AWS + retail. Two separate businesses. AWS beats = stock rallies. Seasonality strong (Q4).
- TSLA: Most volatile Mag7. Elon narrative amplifies all moves. Delivery numbers monthly catalyst. Options flow extreme.

SECTOR ROTATION INTELLIGENCE:
- Tech leads in low rates / AI narrative environment
- Financials lead when yield curve steepens
- Energy leads when oil > $85 or geopolitical events
- Defensives (XLU, XLP) lead when VIX > 25
- Small caps (IWM) lead in risk-on, Fed pivot environments
- Gold (GLD) leads in uncertainty / dollar weakness

SPY/QQQ PATTERNS:
- SPY up >1% in first 30min = likely bull day (70% accuracy)
- SPY red at open then goes green by 11am = strong reversal — best bull signal
- QQQ outperforming SPY = tech leadership = momentum environment
- VIX > 20 = elevated risk, reduce size 25%
- VIX > 30 = only defensive plays or cash

MACRO EVENT PLAYBOOK:
- Fed rate decisions: 30min before = reduce all positions 50%. Post-decision = direction trade.
- CPI/PPI higher than expected: Bonds sell, tech sells, energy/financials rally
- CPI lower than expected: Tech rallies, bonds rally, rate-sensitive stocks lead
- Jobs report strong: Mixed — good economy but fear of Fed hiking
- Earnings season (weeks 2-4 of each month): Sector rotation amplified

INSTITUTIONAL FLOW SIGNALS:
- Large cap up 3%+ on 2x+ volume = institutional accumulation — follow it
- Large cap down 3%+ on 2x+ volume = institutional distribution — respect it
- Gap up then consolidation near highs = institutional absorbing — enter on breakout
- Gap up then immediate fade = distribution — short opportunity

OPTIONS-INFORMED PRICE TARGETS:
- Max pain theory: stocks gravitate toward max pain strike at expiration
- High put/call ratio = sentiment too bearish = contrarian bullish
- Unusual options activity = informed money = follow direction
- GEX (gamma exposure) levels act as magnets and resistance

POSITION SIZING FOR LARGE CAPS:
- Mag7 positions: 15-20% of budget (they're liquid enough for larger sizes)
- ETFs (SPY/QQQ): up to 25% of budget (highly liquid, tight spreads)
- Sector leaders: 10-15% of budget
- Never >20% in single name regardless
- Large caps can be held longer — 2-10 day holds are normal

TIME-OF-DAY FOR LARGE CAPS:
- 9:30-10:00am: High volatility, wait for direction confirmation
- 10:00-11:30am: Primary entry window, trend established
- 11:30-1:30pm: Lunch consolidation — holds not new entries
- 2:00-3:30pm: Institutional rebalancing — strong signals
- 3:30-4:00pm: MOC (market on close) orders — amplifies existing trend
`;

// ══════════════════════════════════════════════════════
// MACRO CONTEXT UPDATER
// ══════════════════════════════════════════════════════
async function updateMacroContext() {
  if (!ANTHROPIC_KEY) return;
  const prompt = `You are TITAN PRIME macro analyst. Date: ${new Date().toDateString()}
Current SPY: ${spyChange}% | VIX estimate: ${vixLevel} | Regime: ${marketRegime}

What is the current macro environment for large cap US equities?
Return ONLY JSON (be very concise): {
  "fedStance":"HAWKISH|NEUTRAL|DOVISH",
  "inflationTrend":"RISING|FALLING|STABLE",
  "riskEnvironment":"RISK_ON|RISK_OFF|NEUTRAL",
  "keyRisk":"biggest current macro risk in one phrase",
  "opportunity":"best large cap opportunity right now in one phrase",
  "events":[{"date":"...","event":"...","impact":"HIGH|MEDIUM"}]
}`;
  try {
    const result = await callClaude(prompt, 500);
    if (!result) return;
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return;
    let data;
    try { data = JSON.parse(match[0]); }
    catch (e) {
      const lastComma = match[0].lastIndexOf(',"');
      if (lastComma > 0) try { data = JSON.parse(match[0].slice(0, lastComma) + '}'); } catch (e2) { return; }
      if (!data) return;
    }
    macroContext = { ...data, lastUpdated: new Date().toISOString() };
    saveJSON('macro.json', macroContext);
    broadcast('MACRO_UPDATE', macroContext);
    console.log(`🌍 Macro: ${data.riskEnvironment} | Fed: ${data.fedStance} | Risk: ${data.keyRisk}`);
  } catch (e) {}
}

async function updateSectorRotation() {
  if (!ANTHROPIC_KEY) return;
  const prompt = `You are TITAN PRIME sector rotation analyst. Date: ${new Date().toDateString()}
SPY: ${spyChange}% | Regime: ${marketRegime} | Fed: ${macroContext.fedStance || 'NEUTRAL'}
Which sectors are leading and lagging RIGHT NOW?
Return ONLY JSON: {"leading":["tech","financials"],"lagging":["utilities","bonds"],"narrative":"one sentence","bestEtf":"QQQ|SPY|XLF|XLE|GLD|TLT","lastUpdated":"${new Date().toISOString()}"}`;
  try {
    const result = await callClaude(prompt, 300);
    if (!result) return;
    const match = result.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        sectorRotation = JSON.parse(match[0]);
        saveJSON('sectors.json', sectorRotation);
        broadcast('SECTOR_UPDATE', sectorRotation);
        console.log(`🔄 Sectors leading: ${sectorRotation.leading?.join(', ')}`);
      } catch (e) {}
    }
  } catch (e) {}
}

// ══════════════════════════════════════════════════════
// CLAUDE API
// ══════════════════════════════════════════════════════
async function callClaude(prompt, maxTokens = 400) {
  if (!ANTHROPIC_KEY) return null;
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: MODEL, max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      timeout: 25000
    });
    return resp.data?.content?.[0]?.text || null;
  } catch (e) { console.error('Claude error:', e.message); return null; }
}

function parseJSON(text) {
  try { const m = text?.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
  catch (e) { return null; }
}

// ══════════════════════════════════════════════════════
// 7-FACTOR POSITION SIZING
// ══════════════════════════════════════════════════════
function calculatePrimeSize(ticker, confidence, volMultiple, patternType, price, avgVolume) {
  // Base budget — larger for prime since we're trading fewer positions
  const budget = 2000;

  // Factor 1: Volume confirmation (large caps always have volume — lower multiplier)
  const volFactor = volMultiple >= 3 ? 1.0 : volMultiple >= 2 ? 0.90 : volMultiple >= 1.5 ? 0.80 : 0.65;

  // Factor 2: Confidence
  const confFactor = confidence >= 82 ? 1.0 : confidence >= 74 ? 0.87 : confidence >= 67 ? 0.75 : 0.60;

  // Factor 3: Pattern type
  const patMultiplier = {
    'INSTITUTIONAL_ACCUMULATION': 1.0, 'EARNINGS_CATALYST': 0.95,
    'SECTOR_ROTATION': 0.90, 'MACRO_PLAY': 0.88,
    'TECHNICAL_BREAKOUT': 0.85, 'ETF_MOMENTUM': 0.92,
    'MAG7_MOMENTUM': 0.90, 'OTHER': 0.75
  };
  const patFactor = patMultiplier[patternType] || 0.75;

  // Factor 4: Market regime
  const regimeFactor = marketRegime === 'BULL_TRENDING' ? 1.0 : marketRegime === 'BULL_RANGING' ? 0.90 :
    marketRegime === 'RANGING' ? 0.80 : marketRegime === 'BEAR_RANGING' ? 0.65 : 0.50;

  // Factor 5: Macro environment
  const macroFactor = macroContext.riskEnvironment === 'RISK_ON' ? 1.0 :
    macroContext.riskEnvironment === 'NEUTRAL' ? 0.85 : 0.65;

  // Factor 6: Portfolio heat
  const heatFactor = portfolioHeat < 0.3 ? 1.0 : portfolioHeat < 0.5 ? 0.85 : 0.70;

  // Factor 7: Historical win rate for this ticker
  const tickerWR = learning.tickerWR[ticker] || 0.5;
  const wrFactor = tickerWR >= 0.65 ? 1.10 : tickerWR >= 0.55 ? 1.0 : tickerWR >= 0.45 ? 0.88 : 0.75;

  const sizeFactor = volFactor * confFactor * patFactor * regimeFactor * macroFactor * heatFactor * wrFactor;
  let dollarSize = budget * sizeFactor;

  // Max position size cap
  const maxDollar = 5000 * SETTINGS.maxPositionPct;
  dollarSize = Math.min(dollarSize, maxDollar);

  const heatIfAdded = portfolioHeat + (dollarSize / 10000);
  if (heatIfAdded > SETTINGS.heatCeiling) dollarSize = (SETTINGS.heatCeiling - portfolioHeat) * 10000;

  const qty = price > 0 ? Math.max(1, Math.floor(dollarSize / price)) : 1;
  const stage1Qty = SETTINGS.stagedEntry ? Math.max(1, Math.floor(qty * 0.40)) : qty;

  return { qty: stage1Qty, totalTargetQty: qty, dollarSize: parseFloat(dollarSize.toFixed(2)), sizeFactor: parseFloat(sizeFactor.toFixed(3)) };
}

// ══════════════════════════════════════════════════════
// 6-AI ADVERSARIAL PIPELINE — PRIME SPECIALIST
// ══════════════════════════════════════════════════════

// AI 1 — TECHNICAL + MACRO ANALYST
async function runAI1_Prime(sym, dir, snap) {
  const prompt = `You are TITAN PRIME AI #1 — TECHNICAL & MACRO ANALYST for large cap equities.
${sym} $${snap.price?.toFixed(2)} ${dir} | Change:${snap.change}% | Volume:${snap.volMultiple}x avg
SPY:${spyChange}% | Regime:${marketRegime} | VIX:${vixLevel}
Fed stance: ${macroContext.fedStance||'NEUTRAL'} | Risk env: ${macroContext.riskEnvironment||'NEUTRAL'}
Sector leaders: ${sectorRotation.leading?.join(',')||'unknown'}
Does the technical + macro setup support a ${dir} on this large cap?
Consider: price action, volume, macro tailwinds/headwinds, sector rotation.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":65-90,"reason":"technical+macro reason","stop":${dir==='SHORT'?(snap.price*1.04).toFixed(2):(snap.price*0.95).toFixed(2)},"target":${dir==='SHORT'?(snap.price*0.92).toFixed(2):(snap.price*1.08).toFixed(2)}}`;
  try {
    const result = await callClaude(prompt, 220);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI1'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai1Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI1', dec });
    console.log(`🧠 AI1 ${sym} ${dir}: ${dec.verdict} (${dec.confidence}%)`);
    return dec;
  } catch (e) { return null; }
}

// AI 2 — INSTITUTIONAL FLOW ANALYST
async function runAI2_Institutional(sym, dir, snap) {
  const prompt = `You are TITAN PRIME AI #2 — INSTITUTIONAL FLOW ANALYST.
${sym} $${snap.price?.toFixed(2)} ${dir} | Volume:${snap.volMultiple}x avg | Change:${snap.change}%
High:$${snap.high?.toFixed(2)} Low:$${snap.low?.toFixed(2)} | Open:$${snap.open?.toFixed(2)}
${PRIME_KNOWLEDGE.slice(0, 600)}
What is the institutional flow signal for ${sym}?
High volume + price trending = accumulation. High volume + price falling = distribution.
Is smart money aligned with this ${dir} trade?
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":65-90,"reason":"institutional flow assessment","flowBias":"ACCUMULATION|DISTRIBUTION|NEUTRAL","smartMoneySignal":"BULLISH|BEARISH|NEUTRAL"}`;
  try {
    const result = await callClaude(prompt, 220);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI2'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai2Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI2', dec });
    console.log(`🧠 AI2 FLOW ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.flowBias}]`);
    return dec;
  } catch (e) { return null; }
}

// AI 3 — RISK MANAGER
async function runAI3_Risk(sym, dir, snap, sizeData) {
  const portfolioClean = portfolioHeat < 0.10 && dailyLoss < 100;
  const stopPct = dir === 'SHORT' ? ((snap.price*1.04 - snap.price)/snap.price*100).toFixed(1) : ((snap.price - snap.price*0.95)/snap.price*100).toFixed(1);
  const targetPct = dir === 'SHORT' ? ((snap.price - snap.price*0.92)/snap.price*100).toFixed(1) : ((snap.price*1.08 - snap.price)/snap.price*100).toFixed(1);
  const rr = (parseFloat(targetPct) / parseFloat(stopPct)).toFixed(1);
  const prompt = `You are TITAN PRIME AI #3 — RISK MANAGER. Be decisive. Only reject for specific concrete reasons.
${sym} $${snap.price?.toFixed(2)} ${dir} | Size: $${sizeData.dollarSize}
Heat: ${(portfolioHeat*100).toFixed(0)}% | Daily loss: $${dailyLoss.toFixed(2)}/$${SETTINGS.dailyLossLimit}
Stop: ${stopPct}% away | Target: ${targetPct}% away | R/R: ${rr}:1
VIX: ${vixLevel} | Portfolio clean: ${portfolioClean}
REJECT ONLY IF one of these is true:
1. Heat is above 40%
2. Daily loss is above 60% of the $${SETTINGS.dailyLossLimit} limit
3. R/R ratio is below 1.5:1
4. VIX is above 35 (extreme volatility)
If none of the above apply — verdict is YES. A clean portfolio with good R/R is always approved.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":70-90,"reason":"specific reason or APPROVED","riskRating":"LOW|MEDIUM|HIGH","holdPeriod":"INTRADAY|SWING|POSITION"}`;
  try {
    const result = await callClaude(prompt, 200);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI3'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai3Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI3', dec });
    console.log(`🧠 AI3 ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.riskRating}] R/R:${rr} ${dec.holdPeriod}`);
    return dec;
  } catch (e) { return null; }
}

// AI 4 — SECTOR & NARRATIVE ANALYST
async function runAI4_Sector(sym, dir, snap) {
  const prompt = `You are TITAN PRIME AI #4 — SECTOR ROTATION & NARRATIVE ANALYST.
${sym} $${snap.price?.toFixed(2)} ${dir}
Leading sectors: ${sectorRotation.leading?.join(', ')||'unknown'}
Lagging sectors: ${sectorRotation.lagging?.join(', ')||'unknown'}
Active narrative: ${sectorRotation.narrative||'none'}
Fed: ${macroContext.fedStance||'NEUTRAL'} | Risk env: ${macroContext.riskEnvironment||'NEUTRAL'}
Is ${sym} in a leading sector with a supporting narrative for this ${dir} trade?
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":65-90,"reason":"sector+narrative assessment","sectorAlignment":"STRONG|MODERATE|WEAK|AGAINST","narrativeFit":"YES|NO"}`;
  try {
    const result = await callClaude(prompt, 200);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI4'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai4Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI4', dec });
    console.log(`🧠 AI4 SECTOR ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.sectorAlignment}]`);
    return dec;
  } catch (e) { return null; }
}

// AI 5 — DEVIL'S ADVOCATE
async function runAI5_Devil(sym, dir, snap) {
  const prompt = `You are TITAN PRIME AI #5 — DEVIL'S ADVOCATE for large cap trades.
${sym} $${snap.price?.toFixed(2)} ${dir} | Change:${snap.change}% | Volume:${snap.volMultiple}x
AIs 1-4 approved this trade. Your job: find every reason it FAILS.
For large caps specifically ask:
- Is this move already priced in by institutional buyers?
- Are we buying after the big money has already bought?
- Is there a macro headwind that will cap the upside?
- Is the sector rotation already mature — are we late?
- What event risk exists in the next 5 trading days?
Only approve if the bear case is genuinely weak.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":65-90,"reason":"devil's assessment","primaryRisk":"biggest specific risk","isLate":"YES|NO"}`;
  try {
    const result = await callClaude(prompt, 250);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI5'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai5Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI5', dec });
    console.log(`🧠 AI5 DEVIL ${sym}: ${dec.verdict} (${dec.confidence}%) — ${dec.primaryRisk}`);
    return dec;
  } catch (e) { return null; }
}

// AI 6 — THE JUDGE
async function runAI6_Judge(sym, dir, snap, a1, a2, a3, a4, a5) {
  const avg = Math.round([a1,a2,a3,a4,a5].filter(Boolean).reduce((s,a)=>s+(a.confidence||0),0)/5);
  const yesCount = [a1,a2,a3,a4,a5].filter(a=>a?.verdict==='YES').length;
  const prompt = `You are TITAN PRIME AI #6 — THE JUDGE. Final authority on large cap trades.
${sym} $${snap.price?.toFixed(2)} ${dir} | Regime:${marketRegime} | SPY:${spyChange}%
AI1 Technical+Macro: ${a1?.verdict} (${a1?.confidence}%)
AI2 Institutional Flow: ${a2?.verdict} (${a2?.confidence}%) [${a2?.flowBias||''}]
AI3 Risk: ${a3?.verdict} (${a3?.confidence}%) [${a3?.holdPeriod||''}]
AI4 Sector+Narrative: ${a4?.verdict} (${a4?.confidence}%) [${a4?.sectorAlignment||''}]
AI5 Devil: ${a5?.verdict} (${a5?.confidence}%) — ${(a5?.primaryRisk||'').slice(0,60)} [Late:${a5?.isLate||'?'}]
Votes YES: ${yesCount}/5 | Avg confidence: ${avg}%
Large caps require institutional alignment AND macro support AND sector leadership.
If Devil says we're late (isLate:YES) — be very cautious even if others agree.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":65-92,"finalReason":"synthesis","urgency":"NOW|WAIT|SKIP","tradeQuality":"A|B|C","holdPeriod":"INTRADAY|SWING|POSITION"}`;
  try {
    const result = await callClaude(prompt, 260);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI6'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai6Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI6', dec });
    console.log(`⚖️ JUDGE ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.tradeQuality}] ${dec.holdPeriod}`);
    return dec;
  } catch (e) { return null; }
}

async function run6AIPipeline(sym, dir, patternType, snap) {
  console.log(`🔱 6-AI PRIME PIPELINE: ${sym} ${dir} [${patternType}]`);
  broadcast('PIPELINE_START', { sym, dir, patternType });

  const sizeData = calculatePrimeSize(sym, 72, snap.volMultiple || 1, patternType, snap.price, snap.avgVolume);

  const a1 = await runAI1_Prime(sym, dir, snap); await sleep(300);
  if (!a1 || a1.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI1`); return null; }

  const a2 = await runAI2_Institutional(sym, dir, snap); await sleep(300);
  if (!a2 || a2.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI2 Flow`); return null; }

  const a3 = await runAI3_Risk(sym, dir, snap, sizeData); await sleep(300);
  if (!a3 || a3.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI3`); return null; }

  const a4 = await runAI4_Sector(sym, dir, snap); await sleep(300);

  const a5 = await runAI5_Devil(sym, dir, snap); await sleep(300);
  if (!a5 || a5.verdict !== 'YES') { console.log(`❌ ${sym} blocked by DEVIL — ${a5?.primaryRisk}`); return null; }

  const a6 = await runAI6_Judge(sym, dir, snap, a1, a2, a3, a4, a5);
  if (!a6 || a6.verdict !== 'YES') { console.log(`❌ ${sym} rejected by JUDGE`); return null; }

  const finalSize = calculatePrimeSize(sym, a6.confidence, snap.volMultiple || 1, patternType, snap.price, snap.avgVolume);
  console.log(`✅ 6-AI PRIME APPROVED: ${sym} ${dir} | ${a6.tradeQuality} | ${a6.holdPeriod} | $${finalSize.dollarSize}`);
  return { a1, a2, a3, a4, a5, a6, sizeData: finalSize };
}

// ══════════════════════════════════════════════════════
// POSITION MANAGEMENT
// ══════════════════════════════════════════════════════
async function enterPosition(sym, dir, patternType, snap, pipelineResult) {
  if (Object.keys(positions).length >= SETTINGS.maxPositions) return false;
  const { sizeData, a6 } = pipelineResult;
  const isShort = dir === 'SHORT';
  const entry = snap.price;
  const stop = isShort ? entry * 1.04 : entry * 0.95;
  const target = isShort ? entry * 0.92 : entry * 1.08;

  const order = await placeOrder(sym, sizeData.qty, isShort ? 'sell' : 'buy');
  if (!order && ALPACA_KEY) return false;

  const pos = {
    ticker: sym, type: dir, entry, stop, target,
    qty: sizeData.qty, totalTargetQty: sizeData.totalTargetQty,
    stage: 1, maxStages: 3, patternType,
    value: entry * sizeData.qty, budget: sizeData.dollarSize,
    sizeFactor: sizeData.sizeFactor,
    unrealizedPnl: 0, peakUnrealizedPnl: 0,
    regime: marketRegime, macroEnv: macroContext.riskEnvironment || 'NEUTRAL',
    holdPeriod: a6.holdPeriod || 'SWING',
    entryTime: new Date().toISOString(),
    aiSummary: `${a6.tradeQuality} | ${a6.holdPeriod} | ${a6.finalReason?.slice(0, 80)}`
  };

  positions[sym] = pos;
  saveJSON('positions.json', positions);
  updateHeat();
  addRotationLog('➕', sym, `${dir} ${patternType} @ $${entry.toFixed(2)}`);
  broadcast('POSITION_OPENED', { sym, pos });
  console.log(`🟢 PRIME ENTER: ${sym} ${dir} @ $${entry.toFixed(2)} | ${sizeData.qty} shares | ${pos.holdPeriod}`);
  return true;
}

async function addToPosition(sym) {
  const pos = positions[sym];
  if (!pos || pos.stage >= pos.maxStages) return;
  const snap = await getSnapshot_stock(sym);
  if (!snap) return;

  const isShort = pos.type === 'SHORT';
  const pnlPct = isShort ? (pos.entry - snap.price) / pos.entry * 100 : (snap.price - pos.entry) / pos.entry * 100;
  if (pnlPct < 1.5) return; // large caps — add at 1.5%

  const addQty = Math.max(1, Math.floor(pos.totalTargetQty * (pos.stage === 1 ? 0.35 : 0.25)));
  const order = await placeOrder(sym, addQty, isShort ? 'sell' : 'buy');
  if (!order && ALPACA_KEY) return;

  pos.qty += addQty; pos.stage++;
  pos.value = snap.price * pos.qty;
  positions[sym] = pos;
  saveJSON('positions.json', positions);
  updateHeat();
  console.log(`📈 PRIME STAGE ${pos.stage}: Added ${addQty}x ${sym} @ $${snap.price.toFixed(2)}`);
}

async function closePosition(sym, reason, snap) {
  const pos = positions[sym];
  if (!pos) return;
  const price = snap?.price || pos.entry;
  const isShort = pos.type === 'SHORT';
  const pnl = isShort ? (pos.entry - price) * pos.qty : (price - pos.entry) * pos.qty;
  const pnlPct = isShort ? (pos.entry - price) / pos.entry * 100 : (price - pos.entry) / pos.entry * 100;

  await placeOrder(sym, pos.qty, isShort ? 'buy' : 'sell');

  totalPnl = parseFloat((totalPnl + pnl).toFixed(2));
  dailyPnl = parseFloat((dailyPnl + pnl).toFixed(2));
  weeklyPnl = parseFloat((weeklyPnl + pnl).toFixed(2));
  totalTrades++; dailyTrades++;
  if (pnl > 0) { totalWins++; consecutiveWins++; consecutiveLoss = 0; }
  else { dailyLoss += Math.abs(pnl); consecutiveLoss++; consecutiveWins = 0; }
  if (totalPnl > allTimePeak) allTimePeak = totalPnl;

  // Update learning
  const tWR = learning.tickerWR[sym] || { wins: 0, total: 0 };
  tWR.total++; if (pnl > 0) tWR.wins++;
  learning.tickerWR[sym] = tWR;
  const pWR = learning.patternWR[pos.patternType] || { wins: 0, total: 0 };
  pWR.total++; if (pnl > 0) pWR.wins++;
  learning.patternWR[pos.patternType] = pWR;
  learning.totalDecisions++;
  saveJSON('learning.json', learning);
  saveState();

  tradeJournal.unshift({ ticker: sym, type: pos.type, entry: pos.entry, exit: price, pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)), patternType: pos.patternType, regime: pos.regime, holdPeriod: pos.holdPeriod, stage: pos.stage, entryTime: pos.entryTime, exitTime: new Date().toISOString(), reason });
  tradeJournal = tradeJournal.slice(0, 200);
  saveJSON('trades.json', tradeJournal);

  const icon = pnl > 0 ? '🏆' : '📉';
  console.log(`${icon} PRIME CLOSE: ${sym} | P&L: ${pnl>=0?'+':''}$${pnl.toFixed(2)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%) | ${reason}`);
  addRotationLog('➖', sym, reason);
  delete positions[sym];
  saveJSON('positions.json', positions);
  updateHeat();
  broadcast('POSITION_CLOSED', { sym, pnl, totalPnl });
}

// ══════════════════════════════════════════════════════
// PROACTIVE EXIT INTELLIGENCE
// ══════════════════════════════════════════════════════
async function runExitIntelligence() {
  const syms = Object.keys(positions);
  if (!syms.length) return;

  const snaps = await getMultiSnapshot(syms);

  for (const sym of syms) {
    const pos = positions[sym];
    if (!pos) continue;
    const snap = snaps[sym];
    if (!snap?.price) continue;

    const isShort = pos.type === 'SHORT';
    const pnlPct = isShort ? (pos.entry - snap.price) / pos.entry * 100 : (snap.price - pos.entry) / pos.entry * 100;
    pos.unrealizedPnl = (snap.price - pos.entry) * pos.qty * (isShort ? -1 : 1);
    pos.currentPrice = snap.price;

    // Peak protection — 25% giveback for large caps (more room than small caps)
    if (pos.unrealizedPnl > (pos.peakUnrealizedPnl || 0)) pos.peakUnrealizedPnl = pos.unrealizedPnl;
    const giveBack = pos.peakUnrealizedPnl > 0 ? (pos.peakUnrealizedPnl - pos.unrealizedPnl) / pos.peakUnrealizedPnl : 0;
    if (giveBack > SETTINGS.peakProtection && pos.peakUnrealizedPnl > 20) {
      await closePosition(sym, `Peak protection: gave back ${(giveBack*100).toFixed(0)}%`, snap); continue;
    }

    // Hard stop — 5% for large caps (tighter than small caps)
    if (pnlPct <= -5) { await closePosition(sym, `Stop loss: ${pnlPct.toFixed(2)}%`, snap); continue; }

    // Target hit
    if (pnlPct >= 8) { await closePosition(sym, `Target hit: ${pnlPct.toFixed(2)}%`, snap); continue; }

    // Stage add
    if (pos.stage < pos.maxStages && pnlPct >= 1.5) await addToPosition(sym);

    // Macro reversal — if macro environment flipped against position, exit
    if (pos.macroEnv === 'RISK_ON' && macroContext.riskEnvironment === 'RISK_OFF' && pnlPct < 2) {
      await closePosition(sym, 'Macro environment flipped to RISK_OFF', snap); continue;
    }

    positions[sym] = pos;
  }
  saveJSON('positions.json', positions);
  broadcast('POSITIONS_UPDATE', { positions });
}

// ══════════════════════════════════════════════════════
// PRIME SCANNER — Large cap momentum + institutional flow
// ══════════════════════════════════════════════════════
async function runPrimeScanner() {
  console.log(`🔍 TITAN PRIME: Scanner firing... SPY:${spyChange}% | Regime:${marketRegime}`);
  lastScanTime = new Date().toISOString();

  if (paused || portfolioHeat >= SETTINGS.heatCeiling) return;
  if (dailyLoss >= SETTINGS.dailyLossLimit) { paused = true; pauseReason = 'Daily loss limit'; return; }
  if (Object.keys(positions).length >= SETTINGS.maxPositions) return;

  await getSPYData();

  // Don't trade in extreme bear trending without conviction
  if (marketRegime === 'BEAR_TRENDING' && personality !== 'PRIME_SHORT_HUNTER') {
    console.log('🐻 Bear trending — TITAN PRIME in defensive mode');
    broadcast('SNAPSHOT', getSnapshot());
    return;
  }

  // Pre-market aware thresholds
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = et.getHours(), etMin = et.getMinutes();
  const isPreMarket = etHour >= 4 && (etHour < 9 || (etHour === 9 && etMin < 30));
  const minChange = isPreMarket ? 0.8 : SETTINGS.minMoveThreshold;
  const minVol = isPreMarket ? 1.0 : SETTINGS.minVolMultiple * 1.5;
  const minMag7Change = isPreMarket ? 0.5 : 2.0;
  const minETFChange = isPreMarket ? 0.2 : 0.5;

  // Get snapshots for entire prime universe
  const snaps = await getMultiSnapshot(PRIME_UNIVERSE);
  const available = Object.entries(snaps).filter(([sym, snap]) => snap && snap.price > 0 && !positions[sym]);

  const scanCandidates = [];

  for (const [sym, snap] of available) {
    // Signal 1: Institutional accumulation
    if (snap.change >= minChange && snap.volMultiple >= minVol) {
      scanCandidates.push({ sym, snap, dir: 'LONG', patternType: 'INSTITUTIONAL_ACCUMULATION', score: 85 + Math.min(snap.volMultiple * 2, 10), reason: `Institutional: +${snap.change}% on ${snap.volMultiple}x volume` });
    }

    // Signal 2: Sector ETF momentum
    if (['SPY', 'QQQ', 'IWM', 'XLF', 'XLE', 'GLD'].includes(sym) && snap.change >= minETFChange && snap.volMultiple >= 1.0) {
      scanCandidates.push({ sym, snap, dir: 'LONG', patternType: 'ETF_MOMENTUM', score: 80, reason: `ETF momentum: ${sym} +${snap.change}%` });
    }

    // Signal 3: Mag7 momentum
    if (['NVDA', 'MSFT', 'AAPL', 'GOOGL', 'META', 'AMZN', 'TSLA'].includes(sym) && snap.change >= minMag7Change && snap.volMultiple >= 1.0) {
      scanCandidates.push({ sym, snap, dir: 'LONG', patternType: 'MAG7_MOMENTUM', score: 88, reason: `Mag7: ${sym} +${snap.change}% on ${snap.volMultiple}x` });
    }

    // Signal 4: Technical breakout
    if (snap.price >= snap.high * 0.998 && snap.change >= minChange && snap.volMultiple >= 1.5) {
      scanCandidates.push({ sym, snap, dir: 'LONG', patternType: 'TECHNICAL_BREAKOUT', score: 82, reason: `Breakout: ${sym} at day high +${snap.change}%` });
    }

    // Signal 5: Distribution short
    if (snap.change <= -(minChange * 1.5) && snap.volMultiple >= 1.5 && marketRegime !== 'BULL_TRENDING') {
      scanCandidates.push({ sym, snap, dir: 'SHORT', patternType: 'INSTITUTIONAL_DISTRIBUTION', score: 75, reason: `Distribution: ${sym} -${Math.abs(snap.change)}% on ${snap.volMultiple}x volume` });
    }
  }

  // Sort by score
  scanCandidates.sort((a, b) => b.score - a.score);
  candidates = scanCandidates.slice(0, 10).map(c => ({ ...c, addedAt: new Date().toISOString() }));
  broadcast('CANDIDATES_UPDATE', { candidates });

  console.log(`📊 PRIME scan: ${scanCandidates.length} candidates | SPY:${spyChange}% | Regime:${marketRegime} | PreMarket:${isPreMarket}`);

  // If still no candidates run AI macro scan
  if (scanCandidates.length === 0) {
    console.log('🧠 PRIME AI scan — looking for macro-driven setups...');
    const prompt = `You are TITAN PRIME momentum scanner. Date: ${new Date().toDateString()} Time ET: ${et.toLocaleTimeString()}
SPY: ${spyChange}% | Regime: ${marketRegime} | PreMarket: ${isPreMarket}
Universe: NVDA MSFT AAPL GOOGL META AMZN TSLA AMD COIN PLTR MSTR SPY QQQ GLD
Which 2-3 of these have institutional momentum RIGHT NOW based on pre-market action, news, or macro?
Return ONLY JSON: {"candidates":[{"sym":"NVDA","dir":"LONG","patternType":"MAG7_MOMENTUM","reason":"specific reason","score":75}]}`;
    try {
      const result = await callClaude(prompt, 400);
      const data = parseJSON(result);
      if (data?.candidates) {
        const aiSnaps = await getMultiSnapshot(data.candidates.map(c => c.sym));
        for (const c of data.candidates) {
          const snap = aiSnaps[c.sym];
          if (snap && snap.price > 0 && !positions[c.sym]) {
            scanCandidates.push({ ...c, snap, addedAt: new Date().toISOString() });
          }
        }
        candidates = scanCandidates.slice(0, 10);
        broadcast('CANDIDATES_UPDATE', { candidates });
        console.log(`🧠 AI scan found ${data.candidates.length} candidates`);
      }
    } catch (e) {}
  }

  // Run top candidates through 6-AI pipeline
  for (const candidate of scanCandidates.slice(0, 3)) {
    if (Object.keys(positions).length >= SETTINGS.maxPositions) break;
    if (positions[candidate.sym]) continue;

    addRotationLog('🔍', candidate.sym, candidate.reason.slice(0, 60));
    const result = await run6AIPipeline(candidate.sym, candidate.dir, candidate.patternType, candidate.snap);
    if (result) await enterPosition(candidate.sym, candidate.dir, candidate.patternType, candidate.snap, result);
    await sleep(500);
  }

  broadcast('SNAPSHOT', getSnapshot());
}

// ── HELPERS ──
function updateHeat() {
  const total = Object.values(positions).reduce((s, p) => s + Math.abs(p.value || p.entry * p.qty), 0);
  portfolioHeat = parseFloat(Math.min(total / 10000, 1).toFixed(3));
  broadcast('HEAT_UPDATE', { portfolioHeat });
}

function addRotationLog(icon, ticker, reason) {
  rotationLog.unshift({ icon, ticker, reason, time: new Date().toLocaleTimeString() });
  rotationLog = rotationLog.slice(0, 50);
  broadcast('ROTATION_UPDATE', rotationLog[0]);
}

// ── MARKET HOURS ──
function isMarketHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), m = et.getMinutes(), d = et.getDay();
  if (d === 0 || d === 6) return false;
  return (h > 9 || (h === 9 && m >= 30)) && h < 16;
}

function isExtendedHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), d = et.getDay();
  if (d === 0 || d === 6) return false;
  return (h >= 4 && h < 9) || (h >= 16 && h < 20);
}

// ── SCHEDULING ──
function startSchedules() {
  // Main scan — every 15 minutes during market + extended hours
  setInterval(async () => {
    if (isMarketHours() || isExtendedHours()) await runPrimeScanner();
  }, SETTINGS.scanInterval);

  // Exit intelligence — every 5 minutes
  setInterval(async () => {
    if (Object.keys(positions).length > 0) await runExitIntelligence();
  }, SETTINGS.exitCheckInterval);

  // Macro + sector update — every hour
  setInterval(async () => {
    await updateMacroContext();
    await updateSectorRotation();
  }, 60 * 60 * 1000);

  // Daily reset
  setInterval(() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (et.getHours() === 0 && et.getMinutes() === 0) {
      dailyPnl = 0; dailyLoss = 0; dailyTrades = 0;
      if (paused && pauseReason.includes('Daily')) { paused = false; pauseReason = ''; }
      saveState();
    }
  }, 60 * 1000);

  // Initial startup
  setTimeout(async () => {
    await getSPYData();
    await updateMacroContext();
    await updateSectorRotation();
    await runPrimeScanner();
  }, 5000);

  setTimeout(() => runExitIntelligence(), 20000);
  console.log('⏰ PRIME schedules: scan 15min | exits 5min | macro 1hr');
}

// ── REST API ──
app.get('/health', (req, res) => res.json({ status: 'ok', positions: Object.keys(positions).length }));
app.get('/api/snapshot', (req, res) => res.json(getSnapshot()));
app.get('/api/status', (req, res) => res.json({
  status: 'ONLINE', positions: Object.keys(positions).length,
  portfolioHeat, totalPnl, openPnl: Object.values(positions).reduce((s,p)=>s+(p.unrealizedPnl||0),0),
  dailyPnl, totalTrades, totalWins, winRate: totalTrades>0?totalWins/totalTrades*100:0,
  marketRegime, personality, consecutiveWins, consecutiveLoss, spyChange
}));
app.post('/api/scan', async (req, res) => { res.json({ message: 'PRIME scan triggered' }); await runPrimeScanner(); });
app.post('/api/pause', (req, res) => { paused = true; pauseReason = req.body.reason || 'Manual'; res.json({ paused }); });
app.post('/api/resume', (req, res) => { paused = false; pauseReason = ''; res.json({ paused }); });
app.post('/api/close/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  if (!positions[sym]) return res.status(404).json({ error: 'Not found' });
  const snap = await getSnapshot_stock(sym);
  await closePosition(sym, 'Manual close', snap || { price: positions[sym].entry });
  res.json({ closed: true });
});
app.get('/api/macro', (req, res) => res.json(macroContext));
app.get('/api/sectors', (req, res) => res.json(sectorRotation));
app.get('/api/trades', (req, res) => res.json(tradeJournal.slice(0, 50)));

wss.on('connection', ws => {
  console.log('📱 TITAN PRIME dashboard connected');
  ws.send(JSON.stringify({ type: 'SNAPSHOT', data: getSnapshot() }));
});

// ── STARTUP ──
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   NEXUS TITAN PRIME — Large Cap Momentum Specialist              ║');
  console.log('║   SPY · QQQ · Mag7 · Sector Leaders · Institutional Flow         ║');
  console.log('║   Macro-Aware · 6-AI Adversarial Pipeline · Staged Positions     ║');
  console.log('║   Built Once — Built Permanently — No Ceiling Ever               ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🌌 Claude AI:      ${ANTHROPIC_KEY ? '✅' : '❌ No key'}`);
  console.log(`📊 Alpaca:         ${ALPACA_KEY ? '✅ Connected' : '⚠️ No key — simulation mode'}`);
  console.log(`📈 Mode:           ${IS_PAPER ? 'PAPER TRADING' : '🔴 LIVE'}`);
  console.log(`🌍 Regime:         ${marketRegime}`);
  console.log(`💼 Positions:      ${Object.keys(positions).length} open`);
  console.log(`🧠 Total trades:   ${totalTrades}`);
  console.log('');
  console.log('🔱 6-AI PRIME PIPELINE:');
  console.log('   AI1 Technical+Macro → AI2 Institutional Flow → AI3 Risk → AI4 Sector+Narrative → AI5 Devil → AI6 Judge');
  console.log('');
  console.log(`🎯 PRIME UNIVERSE: ${PRIME_UNIVERSE.join(' · ')}`);
  console.log('');
  updateHeat();
  startSchedules();
  console.log('✅ NEXUS TITAN PRIME — The hunt for institutional flow begins');
});
