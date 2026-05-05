#!/usr/bin/env node
/**
 * 投资组合截图扫描脚本
 * 用法: node scan-portfolio.js
 * 扫描桌面"投资理财"文件夹下各平台截图，生成文件清单。
 * 未来可接入AI OCR自动提取持仓数据。
 */

const fs = require('fs');
const path = require('path');

const BASE = path.join(require('os').homedir(), 'Desktop', '投资理财');
const OUTPUT = path.join(__dirname, 'portfolio-files.json');

function scan() {
  if (!fs.existsSync(BASE)) {
    console.error('文件夹不存在:', BASE);
    process.exit(1);
  }

  const result = { scannedAt: new Date().toISOString(), platforms: {}, total: 0 };

  const dirs = fs.readdirSync(BASE, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'fund-dashboard');

  for (const dir of dirs) {
    const dirPath = path.join(BASE, dir.name);
    const files = fs.readdirSync(dirPath)
      .filter(f => /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(dirPath, f));
        return {
          name: f,
          size: stat.size,
          sizeKB: (stat.size / 1024).toFixed(1),
          date: stat.mtime.toISOString().slice(0, 10)
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));

    if (files.length > 0) {
      result.platforms[dir.name] = { count: files.length, files };
      result.total += files.length;
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2), 'utf8');
  console.log(`扫描完成: ${result.total} 张截图, ${Object.keys(result.platforms).length} 个平台`);
  console.log(JSON.stringify(result, null, 2));
}

scan();
