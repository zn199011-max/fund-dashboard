const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');

// 1. Fix parseJDFunds name2 cleaning: don't strip digits that are part of ETF names like A500
// Old: name2 = name2.replace(/[\d.+\-×%].*$/, '');
// New: only strip trailing numeric patterns like " 0.00 +1.74%"
s = s.replace(
  "name2 = name2.replace(/[\\\\d.+\\\\-×%].*$/, '');",
  "// Strip trailing numeric/symbol patterns but keep digits in fund names (e.g. A500, 500ETF)\n    name2 = name2.replace(/(?:\\s+|\\b)[\\d.]+\\s*[+\\-]?\\d*\\.?\\d*%?\\s*$/, '').replace(/\\s*[+\\-]\\d+\\.\\d+\\s*$/, '');"
);

// 2. Fix parseAliFunds name2 cleaning similarly
s = s.replace(
  "name2 = name2.replace(/[<>\\[\\]()（）«»「」『』【】@XxVv]+/g, '').trim();",
  "name2 = name2.replace(/(?:\\s+|\\b)[\\d.]+\\s*[+\\-]?\\d*\\.?\\d*%?\\s*$/, '').replace(/\\s*[+\\-]\\d+\\.\\d+\\s*$/, '').replace(/[<>\\[\\]()（）«»「」『』【】@XxVv]+/g, '').trim();"
);

// 3. Fix "预计" cleaning in cleanFundName
s = s.replace(
  "    .replace(/O/g, '0')           // Common OCR errors: O→0",
  "    .replace(/预计.*$/, '')        // Strip \"预计09日更新\" etc\n    .replace(/O/g, '0')           // Common OCR errors: O→0"
);

// 4. Fix Dedup: for JD funds, use first 8 chars of first Chinese name chunk for matching
s = s.replace(
  "const key = (h.platform + '|' + h.fund.substring(0, 10)).toLowerCase();",
  "// Better dedup: match on first 8 chars (handles OCR noise variants)\n        let dedupKey = h.fund.replace(/[^\\u4e00-\\u9fff]/g, '').substring(0, 6);\n        if (!dedupKey) dedupKey = h.fund.substring(0, 10);\n        const key = (h.platform + '|' + dedupKey).toLowerCase();"
);

fs.writeFileSync('server.js', s);
console.log('All fixes applied');
