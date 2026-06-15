import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'portfolio.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Data Persistence ---

function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadPortfolio() {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function savePortfolio(portfolio) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(portfolio, null, 2));
}

// --- Classification Logic ---

const EXCHANGE_REGION_MAP = {
  // US
  NMS: 'US', NYQ: 'US', NGM: 'US', NCM: 'US', PCX: 'US', BTS: 'US',
  NYS: 'US', NAS: 'US', OPR: 'US', PNK: 'US', ASE: 'US',
  // Australia
  ASX: 'Australia', AXS: 'Australia',
  // Asia
  HKG: 'Asia', TYO: 'Asia', JPX: 'Asia', KSC: 'Asia', KOE: 'Asia',
  NSI: 'Asia', BSE: 'Asia', SHH: 'Asia', SHZ: 'Asia', TAI: 'Asia',
  KLS: 'Asia', SGX: 'Asia', JAK: 'Asia', BOM: 'Asia',
  // Europe
  LSE: 'Europe', AMS: 'Europe', PAR: 'Europe', GER: 'Europe', MIL: 'Europe',
  STO: 'Europe', HEL: 'Europe', CPH: 'Europe', OSL: 'Europe', SWX: 'Europe',
  FRA: 'Europe', ETR: 'Europe', IOB: 'Europe', MCE: 'Europe', EBS: 'Europe',
  VIE: 'Europe', WAR: 'Europe', ATH: 'Europe', DUB: 'Europe',
};

function classifyRegion(exchange, quoteType, name) {
  const n = (name || '').toLowerCase();
  const isETF = quoteType === 'ETF' || quoteType === 'MUTUALFUND';

  if (isETF) {
    // Ex-US / international keywords
    if (n.includes('ex-us') || n.includes('ex us') || n.includes('ex-u.s') || n.includes('all world ex')) return 'Global ex-US';
    if (n.includes('global') || n.includes('world') || n.includes('all country') || n.includes('acwi') || n.includes('international')) return 'Global';
    if (n.includes('emerging') || n.includes('em market')) return 'Emerging';

    // Specific regions from name
    if (n.includes('australia') || n.includes('asx') || n.includes('s&p/asx')) return 'Australia';
    if (n.includes('europe') || n.includes('euro stoxx') || n.includes('ftse developed europe') || n.includes('msci eu')) return 'Europe';
    if (
      n.includes('asia') || n.includes('pacific') || n.includes('japan') ||
      n.includes('china') || n.includes('hong kong') || n.includes('india') ||
      n.includes('korea') || n.includes('taiwan') || n.includes('singapore') ||
      n.includes('nikkei') || n.includes('topix') || n.includes('hang seng')
    ) return 'Asia';

    // US-focused ETF keywords
    if (
      n.includes('s&p 500') || n.includes('s&p500') || n.includes('russell') ||
      n.includes('nasdaq') || n.includes('dow jones') || n.includes('us ') ||
      n.includes('u.s.') || n.includes('total stock') || n.includes('total market') ||
      n.includes('crsp')
    ) return 'US';
  }

  // Fall back to exchange-based for individual stocks and unmatched ETFs
  return EXCHANGE_REGION_MAP[exchange] || 'Other';
}

function classifyAssetType(quoteType, sector, name) {
  const n = (name || '').toLowerCase();

  if (quoteType === 'EQUITY') {
    if (sector === 'Real Estate') return 'REIT';
    return 'Stock';
  }
  if (quoteType === 'ETF' || quoteType === 'MUTUALFUND') {
    if (
      n.includes('bond') ||
      n.includes('fixed income') ||
      n.includes('treasury') ||
      n.includes('aggregate') ||
      n.includes('income fund') ||
      n.includes('govt')
    ) {
      return 'Bond';
    }
    if (n.includes('reit') || n.includes('real estate') || n.includes('property')) {
      return 'REIT';
    }
    if (n.includes('money market') || n.includes('cash')) {
      return 'Cash';
    }
    return 'Stock';
  }
  return 'Other';
}

function classifyStyle(marketCap, trailingPE, quoteType, name) {
  const n = (name || '').toLowerCase();
  const isETF = quoteType === 'ETF' || quoteType === 'MUTUALFUND';

  // For ETFs/funds, infer style from the name
  if (isETF) {
    let size = 'Large Cap';
    if (n.includes('small') || n.includes('micro')) size = 'Small Cap';
    else if (n.includes('mid')) size = 'Mid Cap';
    // S&P 500, total market, large-cap indices → Large Cap
    else if (n.includes('s&p 500') || n.includes('s&p500') || n.includes('large')) size = 'Large Cap';

    let category = 'Blend';
    if (n.includes('value')) category = 'Value';
    else if (n.includes('growth')) category = 'Growth';

    return `${size} ${category}`;
  }

  // For individual stocks, use marketCap and P/E
  let size = 'Small Cap';
  if (marketCap > 10e9) size = 'Large Cap';
  else if (marketCap > 2e9) size = 'Mid Cap';

  let category = 'Blend';
  if (trailingPE != null && trailingPE > 0) {
    if (trailingPE < 15) category = 'Value';
    else if (trailingPE > 25) category = 'Growth';
  }

  return `${size} ${category}`;
}

// --- Yahoo Finance (via curl to avoid Node TLS fingerprint blocking) ---

const quoteCache = new Map();
const rateCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function yfFetch(url) {
  const { stdout } = await execFileAsync('curl', [
    '-s', '-f',
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    '-H', 'Accept: application/json',
    url,
  ], { timeout: 15000 });
  return JSON.parse(stdout);
}

async function getQuoteData(ticker) {
  const cached = quoteCache.get(ticker);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Use the v8 chart endpoint (no crumb required)
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const chartJson = await yfFetch(chartUrl);
  const result = chartJson.chart?.result?.[0];
  if (!result) {
    throw new Error(`Ticker "${ticker}" not found`);
  }

  const meta = result.meta;
  const name = meta.longName || meta.shortName || meta.symbol;
  const price = meta.regularMarketPrice;
  const currency = meta.currency;
  const exchange = meta.exchangeName;
  const quoteType = (meta.instrumentType || '').toUpperCase();

  const data = {
    ticker: meta.symbol,
    name,
    price,
    currency,
    quoteType,
    exchange,
    assetType: classifyAssetType(quoteType, null, name),
    region: classifyRegion(exchange, quoteType, name),
    style: classifyStyle(0, null, quoteType, name),
  };

  quoteCache.set(ticker, { data, timestamp: Date.now() });
  return data;
}

async function getExchangeRate(from, to) {
  if (from === to) return 1;
  const key = `${from}${to}`;
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.rate;
  }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${from}${to}%3DX?interval=1d&range=1d`;
    const json = await yfFetch(url);
    const rate = json.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!rate) throw new Error('No rate');
    rateCache.set(key, { rate, timestamp: Date.now() });
    return rate;
  } catch {
    console.warn(`Could not fetch FX rate ${from}→${to}, using 1.0`);
    return 1;
  }
}

// --- API Routes ---

app.get('/api/portfolio', async (req, res) => {
  try {
    const baseCurrency = req.query.base || 'AUD';
    const portfolio = loadPortfolio();

    const enriched = await Promise.all(
      portfolio.map(async (holding) => {
        try {
          const quote = await getQuoteData(holding.ticker);
          const fxRate = await getExchangeRate(quote.currency, baseCurrency);
          const value = quote.price * holding.quantity;
          const valueBase = value * fxRate;
          return { ...holding, ...quote, value, valueBase, baseCurrency, fxRate };
        } catch (err) {
          return {
            ...holding,
            error: err.message,
            value: 0,
            valueBase: 0,
            baseCurrency,
          };
        }
      })
    );

    const totalValue = enriched.reduce((sum, h) => sum + (h.valueBase || 0), 0);

    const byAssetType = {};
    const byRegion = {};
    const byStyle = {};

    for (const h of enriched) {
      if (h.error) continue;
      const pct = totalValue > 0 ? (h.valueBase / totalValue) * 100 : 0;
      byAssetType[h.assetType] = (byAssetType[h.assetType] || 0) + pct;
      byRegion[h.region] = (byRegion[h.region] || 0) + pct;
      byStyle[h.style] = (byStyle[h.style] || 0) + pct;
    }

    res.json({
      holdings: enriched,
      totalValue,
      baseCurrency,
      allocation: { byAssetType, byRegion, byStyle },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/holdings', (req, res) => {
  const { ticker, currency, quantity } = req.body;
  if (!ticker || quantity == null) {
    return res.status(400).json({ error: 'Ticker and quantity are required' });
  }

  const sanitizedTicker = String(ticker).toUpperCase().replace(/[^A-Z0-9.\-=]/g, '');
  if (!sanitizedTicker) {
    return res.status(400).json({ error: 'Invalid ticker' });
  }

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'Quantity must be a positive number' });
  }

  const portfolio = loadPortfolio();
  const holding = {
    id: crypto.randomUUID(),
    ticker: sanitizedTicker,
    currency: currency ? String(currency).toUpperCase().replace(/[^A-Z]/g, '') : 'USD',
    quantity: qty,
    addedAt: new Date().toISOString(),
  };
  portfolio.push(holding);
  savePortfolio(portfolio);
  res.status(201).json(holding);
});

app.delete('/api/holdings/:id', (req, res) => {
  const portfolio = loadPortfolio();
  const index = portfolio.findIndex((h) => h.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Holding not found' });
  }
  portfolio.splice(index, 1);
  savePortfolio(portfolio);
  res.json({ success: true });
});

app.get('/api/lookup/:ticker', async (req, res) => {
  try {
    const ticker = req.params.ticker.toUpperCase().replace(/[^A-Z0-9.\-=]/g, '');
    const data = await getQuoteData(ticker);
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: `Ticker not found: ${err.message}` });
  }
});

// --- Start ---

ensureDataDir();
app.listen(PORT, () => {
  console.log(`Portfolio tracker running at http://localhost:${PORT}`);
});
