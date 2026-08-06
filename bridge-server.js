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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`==============================================`);
  console.log(`   AI六步法选品搜索引擎 — 桥接服务已启动`);
  console.log(`   静态文件: ${STATIC_DIR}`);
  console.log(`   访问地址: http://localhost:${PORT}`);
  console.log(`   搜索API:  POST http://localhost:${PORT}/api/search`);
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
