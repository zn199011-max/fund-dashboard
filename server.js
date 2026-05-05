#!/usr/bin/env node
/**
 * 基金仪表盘本地服务器
 * 用法: node server.js [port]
 * - 托管仪表盘页面
 * - 扫描桌面截图文件夹
 * - 通过AI视觉API自动提取持仓数据
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = parseInt(process.argv[2]) || 3000;
const BASE = path.join(require('os').homedir(), 'Desktop', '投资理财');
const WWW = __dirname;
const DATA_FILE = path.join(__dirname, 'portfolio-data.json');
const SCREENSHOT_DIRS = ['京东金融', '支付宝'];

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// Scan screenshots
function scanScreenshots() {
  const result = { scannedAt: new Date().toISOString(), platforms: {}, total: 0 };
  for (const dir of SCREENSHOT_DIRS) {
    const dirPath = path.join(BASE, dir);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath)
      .filter(f => /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(dirPath, f));
        return { name: f, path: path.join(dirPath, f), size: stat.size, sizeKB: (stat.size / 1024).toFixed(1), date: stat.mtime.toISOString().slice(0, 10) };
      });
    if (files.length > 0) {
      result.platforms[dir] = { count: files.length, files };
      result.total += files.length;
    }
  }
  return result;
}

// Serve static files
function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// JSON API helper
function jsonReply(res, data, status) {
  res.writeHead(status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data, null, 2));
}

// Call Anthropic API for vision extraction
async function extractWithAI(filePaths) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  // Build base64 images
  const images = filePaths.map(p => {
    const buf = fs.readFileSync(p);
    const b64 = buf.toString('base64');
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
    return { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } };
  });

  const prompt = `你是一位投资数据提取专家。请仔细查看这些投资APP截图（可能来自京东金融、支付宝等），提取所有你能找到的持仓信息。

对每笔持仓，提取以下字段：
- platform: 平台名称（"京东金融"或"支付宝"）
- fund: 基金/品种名称
- code: 基金代码（6位数字，如有）
- category: 类别（根据基金类型判断：美股QDII、A股指数、A股红利、行业主题、债券固收、现金/货基、其他）
- value: 持仓市值（元，纯数字，如 150000）
- cost: 成本/投入金额（元，纯数字，如 120000。如果没有标注成本，则填写与市值相同的值）

请以JSON数组格式返回，只返回JSON，不要任何其他文字：
[
  {"platform":"京东金融","fund":"华安纳斯达克100ETF联接A","code":"040046","category":"美股QDII","value":150000,"cost":120000},
  ...
]

如果某张截图没有持仓数据（比如只是首页或图表页），跳过该截图。
如果看不清某些字段，用null表示。
重要：请仔细阅读截图中的每一个数字，确保提取的金额准确。`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }]
  });

  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = http.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': data.length
      },
      timeout: 120000
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          if (j.error) { reject(new Error(j.error.message || 'API error')); return; }
          const text = j.content?.[0]?.text || '';
          // Parse JSON from response
          const match = text.match(/\[[\s\S]*\]/);
          if (match) resolve(JSON.parse(match[0]));
          else resolve([]);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

const TESSERACT = 'C:/Program Files/Tesseract-OCR/tesseract.exe';
const TESSDATA = require('os').homedir() + '/tessdata';

// Run OCR on a single image
function ocrImage(filePath) {
  try {
    const result = require('child_process').execSync(
      `"${TESSERACT}" --tessdata-dir "${TESSDATA}" -l chi_sim "${filePath}" stdout`,
      { timeout: 60000, encoding: 'utf8', maxBuffer: 1024 * 1024 }
    );
    return result;
  } catch (e) {
    return '';
  }
}

// Known fund code mapping from name keywords
const FUND_CODE_MAP = [
  { keys: ['天弘纳斯达克','天弘纳指'], code: '019633', cat: '美股QDII' },
  { keys: ['南方纳斯达克','南方纳指'], code: '016453', cat: '美股QDII' },
  { keys: ['摩根标普500','摩根标普'], code: '019305', cat: '美股QDII' },
  { keys: ['博时标普500','博时标普'], code: '050025', cat: '美股QDII' },
  { keys: ['华夏国证自由现金流','华夏自由现金流'], code: '023917', cat: 'A股红利' },
  { keys: ['易方达中证A500','易方达A500'], code: '022459', cat: 'A股指数' },
  { keys: ['天弘全球高端制造'], code: '012560', cat: '行业主题' },
  { keys: ['广发远见智选'], code: '022184', cat: '其他' },
  { keys: ['华泰柏瑞质量成长','质量成长'], code: '011453', cat: 'A股指数' },
  { keys: ['华夏有色金属','有色金属ETF'], code: '016650', cat: '行业主题' },
  { keys: ['广发半导体材料','半导体材料设备'], code: '020980', cat: '行业主题' },
  { keys: ['易方达全球成长精选','全球成长精选'], code: '018205', cat: '美股QDII' },
  { keys: ['永赢先锋半导体','半导体智选'], code: '022636', cat: '行业主题' },
  { keys: ['富国中证细分化工','细分化工'], code: '014173', cat: '行业主题' },
  { keys: ['华夏全球科技先锋','全球科技先锋'], code: '018918', cat: '行业主题' },
  { keys: ['易方达中证沪深港黄金','黄金产业股票'], code: '020963', cat: '行业主题' },
  { keys: ['西部利得祥逸债券','祥逸债券'], code: '675163', cat: '债券固收' },
  { keys: ['浙商积存金','积存金'], code: '', cat: '其他' },
];

function matchFundCode(name) {
  for (const entry of FUND_CODE_MAP) {
    for (const key of entry.keys) {
      if (name.includes(key)) return { code: entry.code, cat: entry.cat };
    }
  }
  return { code: '', cat: '其他' };
}

// Extract holdings from OCR text - handles platform-specific formats
function parseOCR(text, platform) {
  const holdings = [];
  const rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Pre-process: join continuation lines (fund names often split across 2 lines)
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    // Skip noisy decoration/header lines
    if (/^[<>[\]{}()（）«»「」『』【】@#$%^&*=+~|\\\/]+$/.test(line)) continue;
    if (/^(我|持|全|股|债|混|名|基|曾|副|限时|实物|交易|定投|更多|市场|投资|基金|积存|金价|企|稳|班|雪|启|口|日|山|田|出|团|J|G|f|河|伟|亘|史|巴|E|工|招|附|弈|陆)/.test(line)) continue;
    if (/^(基金销售|产品周报|基金经理|投资锦囊|市场解读|你关注的|DeepSeek)/.test(line)) continue;
    lines.push(line);
  }

  // Gold/积存金 pattern for 京东金融
  if (platform === '京东金融') {
    parseGold(lines, holdings);
    parseJDFunds(lines, holdings);
  }

  // Alipay fund list pattern
  if (platform === '支付宝') {
    parseAliFunds(lines, holdings);
  }

  return holdings;
}

function parseGold(lines, holdings) {
  // Check if this screenshot looks like a gold/cash page (collapse spaces for OCR noise)
  const fullText = lines.join('').replace(/\s+/g, '');
  const hasGold = /积存金|黄金持仓/.test(fullText);
  if (!hasGold) return;

  let goldName = '积存金';
  let goldValue = 0, goldCost = 0, goldWeight = 0, goldAvgPrice = 0;

  // Detect specific gold account
  if (/浙商/.test(fullText)) goldName = '浙商积存金';
  else if (/民生/.test(fullText)) goldName = '民生积存金';

  // Scan for value: "XX,XXX.XX 元" or "XX,XXX.XX元"
  for (const line of lines) {
    const cleaned = line.replace(/\s+/g, '');
    // Value with 元: "44,602.25元"
    let m = cleaned.match(/(\d{2,3}(?:,\d{3})*\.\d{2})元/);
    if (m) {
      const v = parseFloat(m[1].replace(/,/g, ''));
      if (v > 1000 && v < 1e7) goldValue = Math.round(Math.max(goldValue, v));
    }
    // Weight: "43.9808"
    m = cleaned.match(/(\d{2}\.\d{4})/);
    if (m) {
      const w = parseFloat(m[1]);
      if (w > 1 && w < 1000) goldWeight = w;
    }
    // Average cost price: standalone "1,119.70" (around 100-5000 range)
    m = cleaned.match(/(\d{1}(?:,\d{3})*\.\d{2})/g);
    if (m && goldWeight > 0) {
      for (const num of m) {
        const v = parseFloat(num.replace(/,/g, ''));
        if (v > 100 && v < 10000 && Math.abs(v * goldWeight - goldValue) < goldValue * 0.5) {
          goldAvgPrice = v;
        }
      }
    }
  }

  // Calculate cost
  if (goldWeight > 0 && goldAvgPrice > 0) {
    goldCost = Math.round(goldWeight * goldAvgPrice);
  }

  if (goldValue > 0) {
    if (!goldCost || goldCost <= 0) goldCost = goldValue;
    holdings.push({
      platform: '京东金融',
      fund: goldName,
      code: '',
      category: '其他',
      value: goldValue,
      cost: goldCost
    });
  }
}

function parseJDFunds(lines, holdings) {
  // JD fund format: 2 lines per fund
  // Line 1: fund name part 1 + value + daily gain
  // Line 2: fund type suffix (QDII, ETF, 指数 etc.) + cost basis + holding rate
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i];
    const l2 = lines[i + 1];

    // Skip lines that are clearly not fund entries
    if (/^(成交|交易|条件|明细|福利|实物|基金销)/.test(l1)) continue;
    if (l1.length < 8) continue;

    // Look for value: number with 2 decimal places, optionally with comma (like 1,184.25 or 2875.93)
    const v1 = l1.match(/(\d{1,3}(?:,\d{3})*\.\d{2})/);
    if (!v1) continue;

    const value = parseFloat(v1[1].replace(/,/g, ''));
    if (value < 10 || value > 1e7) continue;

    // Fund name part 1 is before the value
    const valIdx = l1.indexOf(v1[1]);
    let name1 = l1.substring(0, valIdx).trim();
    // Must have meaningful Chinese text
    name1 = name1.replace(/^[<{[(\s\d.+\-×%@#°。，,、]+/, '').trim();
    // Must contain at least some Chinese chars or recognizable fund keywords
    if (!/[一-鿿]{2,}/.test(name1)) continue;
    if (name1.length < 3) continue;

    // Line 2 should be a fund type continuation or suffix
    let name2 = l2.trim();
    // Remove trailing numbers and special chars
    name2 = name2.replace(/[\s]+\d.*$/, '');
    name2 = name2.replace(/[<>\[\]()（）«»「」『』【】@XxVv]+/g, '').trim();

    // Only combine if line 2 looks like a fund type suffix
    if (!/^(指数|ETF|混合|债券|联接|产业|发起|主题|股票|精选|积存|QDII|QD)/.test(name2)) {
      continue; // Not a continuation line, skip this pair
    }

    const fullName = name1 + name2;
    if (fullName.length < 6) continue; // Fund name must be reasonably long
    if (fullName.includes('积存金') || fullName.includes('条件单') || fullName.includes('交易记录')) continue;

    const { code, cat } = matchFundCode(fullName);

    holdings.push({
      platform: '京东金融',
      fund: fullName,
      code,
      category: cat,
      value: Math.round(value),
      cost: Math.round(value)
    });
  }
}

function parseAliFunds(lines, holdings) {
  // Alipay format: 2 lines per fund
  // Line 1: "fundNamePart1 value dailyGain"
  // Line 2: "fundNamePart2 0.00 holdingReturnRate"
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i];
    const l2 = lines[i + 1];

    // Find value in line 1: number with 2 decimal places, possibly with comma
    const v1 = l1.match(/(\d{1,3}(?:,\d{3})*\.\d{2})/);
    if (!v1) continue;

    const value = parseFloat(v1[1].replace(/,/g, ''));
    if (value < 1 || value > 1e7) continue;

    // Get fund name from before the value
    const idx = l1.indexOf(v1[1]);
    let name1 = l1.substring(0, idx).trim();
    name1 = name1.replace(/^[<{[(\s\d.+\-×%@#]+/, '').trim();
    if (name1.length < 2) continue;

    // Line 2: fund type suffix (usually starts with Chinese chars not numbers)
    let name2 = l2.trim();
    // Remove numbers and following content
    const numIdx = name2.search(/\d/);
    if (numIdx > 0) name2 = name2.substring(0, numIdx).trim();
    name2 = name2.replace(/[<>\[\]()（）«»「」『』【】@定投]+/g, '').trim();

    const fullName = name1 + name2;
    if (fullName.length < 4) continue;

    // Get holding return rate for cost estimation
    const retMatch = l2.match(/([+\-]\d{1,2}\.\d{1,2})%/);
    let cost = value;
    if (retMatch) {
      const retPct = parseFloat(retMatch[1]);
      if (Math.abs(retPct) < 100) {
        cost = Math.round(value / (1 + retPct / 100));
      }
    }

    const { code, cat } = matchFundCode(fullName);

    holdings.push({
      platform: '支付宝',
      fund: fullName,
      code,
      category: cat,
      value: Math.round(value),
      cost
    });
  }
}

// Clean up OCR noise from fund names
function cleanFundName(name) {
  return name
    .replace(/\s+/g, '')           // Remove OCR-added spaces between chars
    .replace(/[<>\[\]()（）{}«»「」『』【】@#$%^&*+=~|\\\/]+/g, '')
    .replace(/^[.,，。、\d\s]+/, '')
    .replace(/[.,，。、\d\s]+$/, '')
    .replace(/0/g, '0')           // Common OCR errors: O→0
    .replace(/QDI0/g, 'QDII')     // Fix QDII OCR error
    .replace(/QDI(?![I])/g, 'QDII')
    .replace(/ETF(?![联接发起])/g, 'ETF')
    .trim();
}

// OCR-based scan - fully rebuilds from screenshots
function ocrScanAll() {
  const screenshots = scanScreenshots();
  const allHoldings = [];
  const seen = new Set();

  for (const [platform, info] of Object.entries(screenshots.platforms)) {
    for (const f of info.files) {
      const text = ocrImage(f.path);
      const holdings = parseOCR(text, platform);
      for (const h of holdings) {
        // Clean fund name
        h.fund = cleanFundName(h.fund);
        if (h.fund.length < 4 || h.value <= 0) continue;

        // Re-match fund code with cleaned name
        const { code, cat } = matchFundCode(h.fund);
        if (code && !h.code) h.code = code;
        if (cat !== '其他' && h.category === '其他') h.category = cat;

        const key = (h.platform + '|' + h.fund.substring(0, 15)).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          allHoldings.push(h);
        }
      }
    }
  }

  // If OCR found too few holdings (<3), keep existing data
  if (allHoldings.length < 3) {
    const existing = readJSON(DATA_FILE, { holdings: [], updated: '' });
    if (existing.holdings.length >= 3) {
      console.log('OCR found only', allHoldings.length, 'holdings, keeping existing', existing.holdings.length);
      existing.lastScan = screenshots.scannedAt;
      return existing;
    }
  }

  const data = {
    holdings: allHoldings,
    updated: new Date().toLocaleString('zh-CN'),
    lastScan: screenshots.scannedAt
  };
  writeJSON(DATA_FILE, data);
  console.log('OCR scan: found', allHoldings.length, 'holdings from', screenshots.total, 'screenshots');
  return data;
}

// Request handler
async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  // CORS headers for preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  try {
    // ── Static files ──
    if (route === '/' || route === '/index.html') {
      serveStatic(res, path.join(WWW, 'index.html'));
      return;
    }
    if (route === '/scan-portfolio.js') {
      serveStatic(res, path.join(WWW, 'scan-portfolio.js'));
      return;
    }

    // ── API: Screenshot file list ──
    if (route === '/api/files') {
      const data = scanScreenshots();
      jsonReply(res, data);
      return;
    }

    // ── API: Get portfolio data ──
    if (route === '/api/portfolio' && req.method === 'GET') {
      const data = readJSON(DATA_FILE, { holdings: [], updated: '', lastScan: null });
      jsonReply(res, data);
      return;
    }

    // ── API: Save portfolio data ──
    if (route === '/api/portfolio' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          data.updated = new Date().toLocaleString('zh-CN');
          writeJSON(DATA_FILE, data);
          jsonReply(res, { ok: true, updated: data.updated });
        } catch (e) {
          jsonReply(res, { ok: false, error: 'Invalid JSON' }, 400);
        }
      });
      return;
    }

    // ── API: Trigger AI extraction ──
    if (route === '/api/extract' && req.method === 'POST') {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        jsonReply(res, { ok: false, error: '请设置环境变量 ANTHROPIC_API_KEY' }, 400);
        return;
      }

      const screenshots = scanScreenshots();
      const allFiles = [];
      for (const [platform, info] of Object.entries(screenshots.platforms)) {
        for (const f of info.files) {
          allFiles.push(f);
        }
      }

      if (!allFiles.length) {
        jsonReply(res, { ok: false, error: '未找到截图文件' }, 404);
        return;
      }

      try {
        const holdings = await extractWithAI(allFiles.map(f => f.path));
        if (holdings && holdings.length > 0) {
          // Merge with existing data
          const existing = readJSON(DATA_FILE, { holdings: [], updated: '' });
          const merged = [...existing.holdings];
          for (const h of holdings) {
            // Avoid duplicates by fund+platform
            const dup = merged.find(m => m.fund === h.fund && m.platform === h.platform);
            if (!dup) merged.push(h);
          }
          writeJSON(DATA_FILE, {
            holdings: merged,
            updated: new Date().toLocaleString('zh-CN'),
            lastScan: screenshots.scannedAt
          });
          jsonReply(res, { ok: true, extracted: holdings.length, total: merged.length, holdings: merged });
        } else {
          jsonReply(res, { ok: false, error: 'AI未能从截图中提取到数据，请确认截图包含持仓页面' }, 422);
        }
      } catch (e) {
        jsonReply(res, { ok: false, error: 'AI提取失败: ' + e.message }, 500);
      }
      return;
    }

    // ── API: OCR scan (no API key needed) ──
    if (route === '/api/ocr-scan' && req.method === 'POST') {
      try {
        const screenshots = scanScreenshots();
        if (!screenshots.total) {
          jsonReply(res, { ok: false, error: '未找到截图文件' }, 404);
          return;
        }
        const data = ocrScanAll();
        jsonReply(res, { ok: true, total: data.holdings.length, holdings: data.holdings, scannedAt: data.lastScan });
      } catch (e) {
        jsonReply(res, { ok: false, error: 'OCR扫描失败: ' + e.message }, 500);
      }
      return;
    }

    // ── 404 ──
    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    res.writeHead(500);
    res.end('Server error: ' + e.message);
  }
}

const server = http.createServer(handle);
server.listen(PORT, () => {
  console.log(`基金仪表盘服务器已启动: http://localhost:${PORT}`);
  console.log(`仪表盘页面: http://localhost:${PORT}/`);
  console.log(`API - 文件列表: http://localhost:${PORT}/api/files`);
  console.log(`API - 持仓数据: http://localhost:${PORT}/api/portfolio`);
  console.log(`API - OCR扫描: POST http://localhost:${PORT}/api/ocr-scan`);
  console.log(`API - AI提取: POST http://localhost:${PORT}/api/extract`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠ 未设置 ANTHROPIC_API_KEY 环境变量，AI提取功能不可用');
    console.log('  请设置: set ANTHROPIC_API_KEY=your_key  (Windows cmd)');
    console.log('  或: $env:ANTHROPIC_API_KEY="your_key"  (PowerShell)');
  } else {
    console.log('✓ ANTHROPIC_API_KEY 已设置，AI提取功能可用');
  }
});
