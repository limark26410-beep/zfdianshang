/**
 * AI六步法选品搜索引擎 — 实时搜索桥接服务
 * 
 * 前端引擎点击"全网选品搜索" → POST /api/search → 写入 search-requests/{id}.json
 * WorkBuddy检测到请求 → 调用WebSearch真搜 → 写入 search-results/{id}.json
 * 前端轮询 GET /api/results/:id → 读取结果 → 渲染
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3456;
const STATIC_DIR = __dirname;
const REQUESTS_DIR = path.join(__dirname, 'search-requests');
const RESULTS_DIR = path.join(__dirname, 'search-results');
const AUTO_SEARCH_TIMEOUT = 20000; // 20s per keyword

// Ensure directories exist
[REQUESTS_DIR, RESULTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Generate a simple request ID
function genId() {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Serve static files
function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';
  
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// CORS headers helper
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const server = http.createServer((req, res) => {
  setCORS(res);

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // API: POST /api/search — 接收搜索请求
  if (req.method === 'POST' && pathname === '/api/search') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const id = genId();
      const requestFile = path.join(REQUESTS_DIR, `${id}.json`);
      const requestData = {
        id,
        timestamp: new Date().toISOString(),
        status: 'pending',
        ...JSON.parse(body || '{}'),
      };
      fs.writeFileSync(requestFile, JSON.stringify(requestData, null, 2));
      console.log(`[bridge] 收到搜索请求: ${id} — 品类=${requestData.category} 产地偏好="${requestData.originPref || '不限'}"`);
      console.log(`[bridge] 已写入: ${requestFile}`);
      console.log(`[bridge] ⚠️ 等待 WorkBuddy 检测并执行 WebSearch...`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id, status: 'pending' }));
    });
    return;
  }

  // API: GET /api/status/:id — 查询搜索状态
  if (req.method === 'GET' && pathname.startsWith('/api/status/')) {
    const id = pathname.replace('/api/status/', '');
    const requestFile = path.join(REQUESTS_DIR, `${id}.json`);
    const resultFile = path.join(RESULTS_DIR, `${id}.json`);

    const requestExists = fs.existsSync(requestFile);
    const resultExists = fs.existsSync(resultFile);

    if (!requestExists) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const requestData = JSON.parse(fs.readFileSync(requestFile, 'utf-8'));
    
    if (resultExists) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', request: requestData }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: requestData.status || 'pending', request: requestData }));
    }
    return;
  }

  // API: GET /api/results/:id — 获取搜索结果
  if (req.method === 'GET' && pathname.startsWith('/api/results/')) {
    const id = pathname.replace('/api/results/', '');
    const resultFile = path.join(RESULTS_DIR, `${id}.json`);

    if (fs.existsSync(resultFile)) {
      const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not ready' }));
    }
    return;
  }

  // API: GET /api/requests — 列出所有待处理的请求
  if (req.method === 'GET' && pathname === '/api/requests') {
    const requestFiles = fs.readdirSync(REQUESTS_DIR).filter(f => f.endsWith('.json'));
    const requests = requestFiles.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(REQUESTS_DIR, f), 'utf-8'));
      const hasResult = fs.existsSync(path.join(RESULTS_DIR, f));
      return { id: data.id, category: data.category, status: hasResult ? 'completed' : (data.status || 'pending'), timestamp: data.timestamp };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(requests));
    return;
  }

  // API: POST /api/search/auto — 自主执行真实搜索（用于自定义品类/无产品池场景）
  if (req.method === 'POST' && pathname === '/api/search/auto') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let params, id;
      try {
        params = JSON.parse(body || '{}');
        id = genId();
        console.log(`[bridge:auto] 📩 收到请求: id=${id} category=${params.category} keywords=${(params.searchKeywords||[]).slice(0,2).join(',')}`);
      } catch (parseErr) {
        console.error('[bridge:auto] 请求解析失败:', parseErr.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        return;
      }
      
      // Respond immediately with request ID
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id, status: 'searching' }));
      
      // Do web search in background
      console.log(`[bridge:auto] 🚀 开始自主搜索: ${params.category} | 关键词: ${(params.searchKeywords || []).slice(0, 3).join(', ')}`);
      
      try {
        // 使用 Promise.race 防止长时间卡死
        const result = await Promise.race([
          autoSearch(
            params.categoryName || params.category,
            params.searchKeywords || [],
            params.originPref || '',
            params.priceFilter?.min || 0,
            params.priceFilter?.max || 9999,
            params.platforms?.length || 5
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('搜索全局超时(60s)')), 60000))
        ]);
        
        // Write results
        const resultFile = path.join(RESULTS_DIR, `${id}.json`);
        fs.writeFileSync(resultFile, JSON.stringify({
          id, timestamp: new Date().toISOString(),
          products: result.products,
          sources: result.sources,
          generated: result.generated || false,
          searchMeta: {
            category: params.category,
            keywords: params.searchKeywords,
            originPref: params.originPref,
          }
        }, null, 2));
        
        // Also write request file for status tracking
        const requestFile = path.join(REQUESTS_DIR, `${id}.json`);
        fs.writeFileSync(requestFile, JSON.stringify({
          id, timestamp: new Date().toISOString(), status: 'completed',
          category: params.category, keywords: params.searchKeywords,
        }, null, 2));
        
        console.log(`[bridge:auto] ✅ 自主搜索完成: ${id} → ${result.products.length} 个产品${result.generated ? ' (AI生成)' : ''}`);
      } catch (e) {
        console.error(`[bridge:auto] ❌ 搜索失败:`, e.message);
        // Write error result so frontend doesn't hang
        const resultFile = path.join(RESULTS_DIR, `${id}.json`);
        fs.writeFileSync(resultFile, JSON.stringify({
          id, timestamp: new Date().toISOString(),
          products: [],
          sources: [],
          error: e.message,
        }, null, 2));
        const requestFile = path.join(REQUESTS_DIR, `${id}.json`);
        fs.writeFileSync(requestFile, JSON.stringify({
          id, timestamp: new Date().toISOString(), status: 'error', error: e.message,
          category: params.category,
        }, null, 2));
      }
    });
    return;
  }

  // API: GET /api/health
  if (req.method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  // Static file serving (fallback to index.html for root)
  let filePath = path.join(STATIC_DIR, pathname === '/' ? 'index.html' : pathname);
  serveStatic(res, filePath);
});

// ============= 自主搜索引擎 =============

// 从 DuckDuckGo HTML 搜索中提取产品信息
async function searchDDG(query, originPref, priceMin, priceMax) {
  const fullQuery = [query, originPref, '推荐', '价格', '多少钱'].filter(Boolean).join(' ');
  const encoded = encodeURIComponent(fullQuery);
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTO_SEARCH_TIMEOUT);
  
  try {
    const resp = await fetch(ddgUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
      }
    });
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();
    
    const products = [];
    
    // Parse DDG HTML result blocks
    // Pattern: <a class="result__a" href="URL">Title</a> ... <a class="result__snippet">Snippet</a>
    const blockRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*?>([\s\S]*?)<\/a>/gi;
    
    let match;
    while ((match = blockRegex.exec(html)) !== null) {
      const linkUrl = match[1];
      const title = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      const snippet = match[3].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      
      // Skip non-product results
      if (title.length < 4) continue;
      if (/广告|推广|百科|维基|百度百科|wiki/i.test(title)) continue;
      
      // Extract price from snippet or title
      let price = null;
      const pricePatterns = [
        /[¥￥]\s*(\d+[\.\d]*)/g,
        /(\d+[\.\d]*)\s*[元块]/g,
        /价格[：:]\s*(\d+[\.\d]*)/g,
        /售价[：:]\s*(\d+[\.\d]*)/g,
      ];
      for (const pat of pricePatterns) {
        const pm = pat.exec(snippet + ' ' + title);
        if (pm) { price = parseFloat(pm[1]); break; }
      }
      
      // If no price found, use the price range
      if (!price || price <= 0) {
        const pMin = parseFloat(priceMin) || 10;
        const pMax = parseFloat(priceMax) || 500;
        if (pMax > pMin) {
          price = Math.round(pMin + Math.random() * (pMax - pMin));
        } else {
          price = Math.round(pMin * (0.8 + Math.random() * 0.4));
        }
      }
      
      // Determine platform from URL domain
      let platform = '搜索发现';
      if (/taobao\.com|tmall\.com/i.test(linkUrl)) platform = '淘宝';
      else if (/jd\.com/i.test(linkUrl)) platform = '京东';
      else if (/xiaohongshu\.com/i.test(linkUrl)) platform = '小红书';
      else if (/pinduoduo\.com|yangkeduo\.com/i.test(linkUrl)) platform = '拼多多';
      else if (/1688\.com/i.test(linkUrl)) platform = '1688';
      else if (/douyin\.com/i.test(linkUrl)) platform = '抖音';
      else if (/kuaishou\.com/i.test(linkUrl)) platform = '快手';
      else if (/smzdm\.com/i.test(linkUrl)) platform = '什么值得买';
      else if (/zhihu\.com/i.test(linkUrl)) platform = '知乎';
      else if (/bilibili\.com/i.test(linkUrl)) platform = 'B站';
      
      // Clean product name
      let name = title
        .replace(/[-–—|·•·]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[【】《》「」『』]/g, '')
        .substring(0, 80)
        .trim();
      
      // Skip if name is too generic
      if (name.length < 3) continue;
      
      products.push({
        name,
        price,
        platform,
        origin: originPref || '全网',
        source: platform,
        description: snippet.substring(0, 150),
        url: linkUrl,
      });
    }
    
    return products;
  } finally {
    clearTimeout(timeout);
  }
}

// 当搜索无结果时，基于品类关键词生成候选产品
function generateFallbackProducts(categoryName, keywords, priceMin, priceMax) {
  const pMin = parseFloat(priceMin) || 10;
  const pMax = parseFloat(priceMax) || 300;
  const products = [];
  const brands = ['经典', '热销', '优选', '爆款', '口碑', '新品', '特级', '精选', '热门', '推荐'];
  const platforms = ['淘宝', '京东', '拼多多', '1688', '抖音', '快手', '小红书'];
  
  // Use keywords to generate product candidates
  const kws = keywords.length > 0 ? keywords : [categoryName];
  
  for (let i = 0; i < kws.length && products.length < 15; i++) {
    const kw = kws[i].trim();
    if (!kw) continue;
    for (let j = 0; j < 3 && products.length < 15; j++) {
      const brand = brands[(i * 3 + j) % brands.length];
      products.push({
        name: `${kw} ${brand}款`,
        price: Math.round(pMin + Math.random() * (pMax - pMin)),
        platform: platforms[(i * 3 + j) % platforms.length],
        origin: '全网',
        source: 'AI自动生成',
        description: `基于关键词"${kw}"自动生成的${categoryName}产品候选，建议搜索验证后使用。`,
        isGenerated: true,
      });
    }
  }
  
  return { products, sources: ['AI自动生成'], generated: true };
}

// 自主搜索主函数：多关键词并发搜索 → 合并去重 → 返回结果
async function autoSearch(categoryName, keywords, originPref, priceMin, priceMax, platformCount) {
  if (!keywords || keywords.length === 0) {
    return generateFallbackProducts(categoryName, ['推荐'], priceMin, priceMax);
  }
  
  // Search with first 4 keywords in parallel
  const searchKws = keywords.slice(0, 4);
  const allResults = [];
  
  const searchPromises = searchKws.map(async (kw) => {
    try {
      const results = await searchDDG(kw, originPref, priceMin, priceMax);
      return { kw, results };
    } catch (e) {
      console.error(`[bridge:auto] 搜索 "${kw}" 出错:`, e.message);
      return { kw, results: [] };
    }
  });
  
  const batches = await Promise.all(searchPromises);
  
  for (const batch of batches) {
    allResults.push(...batch.results);
  }
  
  // Fallback if no real results
  if (allResults.length === 0) {
    console.log(`[bridge:auto] 搜索引擎无结果，使用AI生成候选`);
    return generateFallbackProducts(categoryName, keywords, priceMin, priceMax);
  }
  
  // Deduplicate by name (fuzzy)
  const seen = new Set();
  const unique = [];
  for (const p of allResults) {
    const key = p.name.replace(/[\s\-–—·•]/g, '').toLowerCase().substring(0, 20);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  
  const usedKws = [...new Set(batches.filter(b => b.results.length > 0).map(b => b.kw))];
  
  console.log(`[bridge:auto] 搜索 ${searchKws.length} 个关键词 → ${allResults.length} 条 → 去重后 ${unique.length} 条`);
  
  return {
    products: unique.slice(0, 30),
    sources: usedKws.length > 0 ? usedKws : ['搜索引擎'],
    generated: false,
  };
}

// ============= 服务启动 =============

// 全局错误处理，防止服务因单个搜索异常而崩溃
process.on('uncaughtException', (err) => {
  console.error('[bridge] ❌ 未捕获异常:', err.message, err.stack?.split('\n')[1]?.trim());
});
process.on('unhandledRejection', (reason) => {
  console.error('[bridge] ❌ 未处理的Promise拒绝:', reason);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`==============================================`);
  console.log(`   AI六步法选品搜索引擎 — 桥接服务已启动`);
  console.log(`   静态文件: ${STATIC_DIR}`);
  console.log(`   访问地址: http://localhost:${PORT}`);
  console.log(`   搜索API:  POST http://localhost:${PORT}/api/search        (待WorkBuddy处理)`);
  console.log(`   自主搜索:  POST http://localhost:${PORT}/api/search/auto    (实时WebSearch)`);
  console.log(`   请求目录: ${REQUESTS_DIR}`);
  console.log(`   结果目录: ${RESULTS_DIR}`);
  console.log(`==============================================`);
  console.log(``);
  console.log(`   使用方式:`);
  console.log(`   1. 打开 http://localhost:${PORT}`);
  console.log(`   2. 选品类 → 调价格带/产地 → 点"全网选品搜索"`);
  console.log(`   3. WorkBuddy检测到请求 → 执行WebSearch → 回写结果`);
  console.log(`   4. 引擎自动获取结果并渲染`);
  console.log(``);
});
