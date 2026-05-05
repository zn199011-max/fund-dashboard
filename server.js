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
  console.log(`API - AI提取: POST http://localhost:${PORT}/api/extract`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠ 未设置 ANTHROPIC_API_KEY 环境变量，AI提取功能不可用');
    console.log('  请设置: set ANTHROPIC_API_KEY=your_key  (Windows cmd)');
    console.log('  或: $env:ANTHROPIC_API_KEY="your_key"  (PowerShell)');
  } else {
    console.log('✓ ANTHROPIC_API_KEY 已设置，AI提取功能可用');
  }
});
