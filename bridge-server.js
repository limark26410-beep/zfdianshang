/**
 * AI六步法选品搜索引擎 v1.4 — 1688产品数据 + SearXNG口碑 + LLM综合分析
 *
 * 三引擎架构：
 *   1688 API（LinkFox）：真实产品页 → 品牌/价格/产地/销量/供应商
 *   SearXNG：全网口碑 → 市场评价/热度/对比
 *   LLM（GLM/DeepSeek/Qwen）：智能分析 → 搜索词优化 + 综合选品报告
 *
 * 流程：
 *   用户输入"白酒 茅台" → LLM 搜索词优化 → 1688 搜产品 + SearXNG 搜口碑
 *   → LLM 综合分析 → {品牌, 产地, 价格, 销量, 来源链接, 选品分析}
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3456;
const STATIC_DIR = __dirname;
const REQUESTS_DIR = path.join(__dirname, 'search-requests');
const RESULTS_DIR = path.join(__dirname, 'search-results');

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://searxng:8080';
const SEARCH_TIMEOUT = 20000;
const SEARCH_ENGINES = 'duckduckgo,bing,brave';

// ═══════════════════ 1688 API 配置 ═══════════════════
const LINKFOX_API = 'https://mcp-tool-gateway.linkfox.com/mcp/any-tool';
const LINKFOX_KEY = process.env.LINKFOX_AGENT_API_KEY || '';
const dldEnabled = !!LINKFOX_KEY;

// ═══════════════════ 多模型配置 ═══════════════════
const LLM_PROVIDERS = [
  { id: 'glm', name: '智谱 GLM-4-Flash', model: 'glm-4-flash', baseURL: 'https://open.bigmodel.cn/api/paas/v4', envKey: 'GLM_API_KEY', cost: '永久免费', priority: 1 },
  { id: 'deepseek', name: 'DeepSeek V3.2', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', cost: '约 ¥0.002/次', priority: 2 },
  { id: 'qwen', name: '通义千问 Qwen3-Plus', model: 'qwen-plus', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envKey: 'QWEN_API_KEY', cost: '约 ¥0.003/次', priority: 3 },
];

const activeProviders = LLM_PROVIDERS.filter(p => process.env[p.envKey]).sort((a, b) => a.priority - b.priority);
const llmEnabled = activeProviders.length > 0;
const activeLLM = llmEnabled ? activeProviders[0] : null;

// ═══════════════════ 启动日志 ═══════════════════
console.log(`==============================================`);
console.log(` AI六步法选品搜索引擎 v1.4`);
console.log(` 产品数据: ${dldEnabled ? '✅ 1688 API (LinkFox)' : '⏸️ 1688 (配置 LINKFOX_AGENT_API_KEY 启用)'}`);
console.log(` 全网搜索: SearXNG（${SEARCH_ENGINES}）`);
console.log(` LLM分析: ${llmEnabled ? activeLLM.name + ' · ' + activeLLM.cost : '未配置（回退基础模式）'}`);
for (const p of LLM_PROVIDERS) {
  const cfg = activeProviders.find(ap => ap.id === p.id);
  console.log(`   ${cfg ? '✅' : '⏸️'} ${p.name} - ${p.cost}${cfg ? ' [活跃]' : ''}`);
}
console.log(` 访问: http://localhost:${PORT}`);
console.log(`==============================================`);

[REQUESTS_DIR, RESULTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ═══════════════════ 工具函数 ═══════════════════

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function genId() { return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getEngineMode() {
  const parts = [];
  if (dldEnabled) parts.push('1688');
  parts.push('searxng');
  if (llmEnabled) parts.push(activeLLM.id);
  return parts.join('+');
}

// ═══════════════════ LLM 统一调用接口 ═══════════════════

async function callLLM(messages, maxTokens = 2000, temperature = 0.3, jsonMode = true) {
  if (!llmEnabled) throw new Error('无可用 LLM');

  let lastError = null;
  for (const provider of activeProviders) {
    const apiKey = process.env[provider.envKey];
    for (let attempt = 0; attempt <= 3; attempt++) {
      const body = { model: provider.model, messages, max_tokens: maxTokens, temperature };
      if (jsonMode) body.response_format = { type: 'json_object' };

      try {
        const resp = await fetch(`${provider.baseURL}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          if (resp.status === 429 && attempt < 3) {
            const waitMs = Math.pow(2, attempt + 1) * 1000;
            console.warn(`[llm:${provider.id}] ⚠️ 429 限流，${waitMs/1000}s 后重试 (${attempt+2}/4)`);
            await sleep(waitMs);
            continue;
          }
          throw new Error(`${provider.name} HTTP ${resp.status}: ${errText.substring(0, 200)}`);
        }

        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content || '';
        if (!content) throw new Error(`${provider.name} 返回空内容`);
        if (jsonMode) {
          try { JSON.parse(content); } catch { throw new Error(`${provider.name} 返回非JSON`); }
        }
        if (attempt > 0) console.log(`[llm:${provider.id}] ✅ 第 ${attempt+1} 次重试成功`);
        return { content, provider: provider.id };
      } catch (e) {
        if (attempt < 3 && (e.name === 'TimeoutError' || e.message?.includes('fetch failed'))) {
          await sleep(Math.pow(2, attempt + 1) * 1000);
          continue;
        }
        console.error(`[llm:${provider.id}] ❌ ${e.message}`);
        lastError = e;
        break;
      }
    }
  }
  throw lastError || new Error('所有 LLM 供应商均失败');
}

// ═══════════════════ 1688 产品搜索 ═══════════════════

async function search1688(keyword, priceMin, priceMax, pageSize = 15) {
  if (!dldEnabled) return null;

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: '/dld/productSearch',
      arguments: {
        keyWord: keyword.substring(0, 50),
        pageSize: Math.min(pageSize, 20),
        sortField: 'orderCount30d',
        sortType: 'desc',
      },
    },
  };
  if (priceMin) body.params.arguments.beginPrice = Number(priceMin);
  if (priceMax) body.params.arguments.endPrice = Number(priceMax);

  try {
    const resp = await fetch(LINKFOX_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': LINKFOX_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error(`[1688] ❌ HTTP ${resp.status}: ${text.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json();
    // LinkFox MCP 网关响应格式: result.content[0].text 里是 JSON 字符串
    let inner;
    try {
      inner = JSON.parse(data.result?.content?.[0]?.text || '{}');
    } catch {
      inner = data;
    }
    
    if (inner.errcode !== 200) {
      console.error(`[1688] ❌ API error: ${inner.errmsg || 'unknown'}`);
      return null;
    }

    const products = (inner.products || []).map(p => ({
      name: p.title || '',
      price: p.price || null,
      consignPrice: p.consignPrice || null,
      company: p.company || '',
      sales30d: p.salesOrderCount || 0,
      salesVolume30d: p.salesQuantity || 0,
      estRevenue: p.estimatedSalesAmount || 0,
      quantityBegin: p.quantityBegin || 0,
      deliveryTime: p.deliveryTime || '',
      shopUrl: p.shopUrl || '',
      productUrl: p.asinUrl || '',
      imageUrl: p.imageUrl || '',
      category: p.levelName || '',
      quantityPrices: p.quantityPrices || '',
      source: '1688',
    }));

    console.log(`[1688] 🔍 "${keyword.substring(0,20)}" → ${products.length}个产品`);
    return { products, total: inner.total || 0 };
  } catch (e) {
    if (e.name === 'AbortError') console.error(`[1688] ⏱️ "${keyword.substring(0,20)}" 超时`);
    else console.error(`[1688] ❌ "${keyword.substring(0,20)}" ${e.message}`);
    return null;
  }
}

// ═══════════════════ LLM 搜索词优化 ═══════════════════

async function optimizeQueriesWithLLM(categoryName, keywords, originPref) {
  if (!llmEnabled) {
    return keywords.map(k => `${k} ${originPref} ${categoryName}`.trim().substring(0, 50));
  }

  const prompt = `生成1688搜索用的精准电商关键词（8-15字中文短词），目标是从1688批发平台获取${categoryName}的真实商品数据。
品类：${categoryName}
产地偏好：${originPref || '不限'}
原始词：${keywords.join('、')}

输出JSON：{"queries": ["词1","词2",...]}
规则：5-8个搜索词。含品牌名、规格（如53度、500ml）、用途（如送礼、口粮）、品类名。不要加"价格""多少钱"等词。`;

  try {
    const { content } = await callLLM([{ role: 'user', content: prompt }], 1000, 0.7);
    const parsed = JSON.parse(content);
    const queries = (parsed.queries || []).slice(0, 8).filter(q => q && q.length > 2);
    if (queries.length >= 3) {
      console.log(`[llm:${activeLLM.id}] 搜索词: ${keywords.slice(0,2).join(',')} → ${queries.length}条精准词`);
      return queries;
    }
  } catch (e) {
    console.error(`[engine] 搜索词优化失败: ${e.message}`);
  }
  return keywords.map(k => `${k} ${originPref} ${categoryName}`.trim().substring(0, 50));
}

// ═══════════════════ SearXNG 搜索 ═══════════════════

async function searchSearXNG(query, count = 8) {
  const params = new URLSearchParams({
    q: query, format: 'json', engines: SEARCH_ENGINES,
    language: 'zh-CN', safesearch: '0',
  });
  const apiUrl = `${SEARXNG_URL}/search?${params.toString()}`;

  try {
    const resp = await fetch(apiUrl, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT),
      headers: { 'Accept': 'application/json' },
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.results) return [];
    return data.results.slice(0, count).map(r => ({
      title: (r.title || '').substring(0, 100),
      snippet: (r.content || r.snippet || '').substring(0, 300),
      url: r.url || '',
      platform: detectPlatform(r.url),
    }));
  } catch { return []; }
}

// ═══════════════════ LLM 综合选品分析 ═══════════════════

async function analyzeWithLLM(categoryName, originPref, priceMin, priceMax, dldProducts, searxngContext) {
  if (!llmEnabled || !dldProducts || dldProducts.length === 0) return null;

  // 构建1688产品摘要
  const productLines = dldProducts.slice(0, 15).map((p, i) => {
    const originHint = extractOrigin(p.name, p.company, originPref);
    return [
      `[${i+1}] ${p.name}`,
      `  供应商: ${p.company}${originHint ? '（产地: ' + originHint + '）' : ''}`,
      `  批发价: ¥${p.price || '?'} | 代发价: ¥${p.consignPrice || '?'} | 月销: ${p.sales30d}笔`,
      `  链接: ${p.productUrl}`,
    ].join('\n');
  }).join('\n\n');

  // 构建SearXNG摘要（精简）
  const contextLines = (searxngContext || []).slice(0, 5).map((r, i) =>
    `[C${i+1}] ${r.platform} | ${r.title} | ${r.snippet}`
  ).join('\n');

  const prompt = `你是电商选品分析师。分析以下1688真实商品数据，结合全网口碑，输出结构化选品报告。

品类：${categoryName} | 产地偏好：${originPref || '不限'} | 价格区间：¥${priceMin||0}-¥${priceMax||9999}

═══ 1688产品数据 ═══
${productLines}

═══ 全网口碑/市场背景 ═══
${contextLines || '（无额外数据）'}

输出纯JSON：
{
  "products": [
    {
      "id": 对应产品编号,
      "name": "产品名称（品牌+品类+规格）",
      "brand": "品牌",
      "origin": "产地（从产品名或公司名推断，如贵州茅台镇/山西杏花村/北京）",
      "price": 批发价数字,
      "consignPrice": 代发价数字或null,
      "platform": "1688",
      "spec": "规格（如53度500ml、整箱12瓶）",
      "salesVolume": "月销数字+单位（如'月销237笔'）",
      "company": "供应商名称",
      "sourceUrl": "1688商品链接（直接复制原文）",
      "score": 1-10分（销量高、价格好、有口碑）
    }
  ],
  "summary": "整体选品建议（2-3句话，含市场趋势和推荐方向）"
}

规则：
- 从1688数据中直接提取，不编造
- 产地从产品标题和公司名推断（如"贵州"→贵州茅台镇，"山西"→山西杏花村）
- 如果有全网口碑数据，在score中体现
- 价格和销量是核心指标
- sourceUrl直接用原文中的链接`;

  try {
    const { content, provider } = await callLLM([{ role: 'user', content: prompt }], 3000, 0.3);
    const parsed = JSON.parse(content);
    if (!parsed.products || parsed.products.length === 0) return null;

    const results = parsed.products.map(p => {
      const src = dldProducts[p.id - 1] || {};
      return {
        name: p.name || src.name || '',
        brand: p.brand || '',
        origin: p.origin || extractOrigin(src.name, src.company, originPref) || '',
        price: p.price || src.price || null,
        consignPrice: p.consignPrice || src.consignPrice || null,
        platform: '1688',
        spec: p.spec || '',
        salesVolume: p.salesVolume || (src.sales30d ? `月销${src.sales30d}笔` : ''),
        company: p.company || src.company || '',
        shopUrl: src.shopUrl || '',
        sourceUrl: p.sourceUrl || src.productUrl || '',
        score: p.score || 5,
        summary: p.summary || '',
        dataQuality: `dld_llm_${provider}`,
        deliveryTime: src.deliveryTime || '',
        quantityBegin: src.quantityBegin || 0,
        salesOrderCount: src.sales30d || 0,
        salesQuantity: src.salesVolume30d || 0,
        estimatedRevenue: src.estRevenue || 0,
      };
    });

    results.sort((a, b) => b.score - a.score);
    console.log(`[llm:${provider}] 分析: ${dldProducts.length}条1688数据 → ${results.length}个选品报告`);
    return { products: results, summary: parsed.summary || '' };
  } catch (e) {
    console.error(`[engine] 综合分析失败: ${e.message}`);
    return null;
  }
}

// ═══════════════════ 产地推断 ═══════════════════

function extractOrigin(productName, company, originPref) {
  const text = `${productName} ${company}`.toLowerCase();
  const mapping = {
    '贵州': '贵州茅台镇', '茅台': '贵州茅台镇', '仁怀': '贵州仁怀',
    '山西': '山西杏花村', '杏花村': '山西杏花村', '汾阳': '山西汾阳',
    '四川': '四川宜宾/泸州', '宜宾': '四川宜宾', '泸州': '四川泸州', '五粮液': '四川宜宾',
    '北京': '北京', '牛栏山': '北京顺义', '红星': '北京',
    '江苏': '江苏宿迁', '洋河': '江苏宿迁', '宿迁': '江苏宿迁',
    '安徽': '安徽亳州', '古井': '安徽亳州', '亳州': '安徽亳州',
    '陕西': '陕西宝鸡', '西凤': '陕西宝鸡',
    '浙江': '浙江绍兴', '绍兴': '浙江绍兴',
  };
  for (const [key, val] of Object.entries(mapping)) {
    if (text.includes(key.toLowerCase())) return val;
  }
  return originPref || '';
}

// ═══════════════════ 基础回退 ═══════════════════

function fallbackProducts(dldProducts, searxngResults, priceMin, priceMax) {
  // 如果有1688数据，直接用（不需要LLM分析）
  if (dldProducts && dldProducts.length > 0) {
    return dldProducts.slice(0, 20).map(p => ({
      name: p.name, brand: '', origin: extractOrigin(p.name, p.company, ''),
      price: p.price, consignPrice: p.consignPrice,
      platform: '1688', spec: '',
      salesVolume: p.sales30d ? `月销${p.sales30d}笔` : '',
      company: p.company, shopUrl: p.shopUrl || '', sourceUrl: p.productUrl || '',
      score: Math.min(8, Math.ceil(p.sales30d / 30)),
      summary: p.company ? `供应商: ${p.company}` : '',
      dataQuality: 'dld_direct', deliveryTime: p.deliveryTime, quantityBegin: p.quantityBegin,
      salesOrderCount: p.sales30d, salesQuantity: p.salesVolume30d, estimatedRevenue: p.estRevenue,
    }));
  }

  // 无1688数据，回退SearXNG+正则
  if (searxngResults && searxngResults.length > 0) {
    return extractWithRegex(searxngResults, priceMin, priceMax);
  }

  // 完全无数据
  return [];
}

function extractWithRegex(rawResults, priceMin, priceMax) {
  const seen = new Set();
  const products = [];
  for (const r of rawResults) {
    const key = r.title.replace(/[\s\-–—·•]/g, '').toLowerCase().substring(0, 30);
    if (seen.has(key)) continue;
    seen.add(key);
    const combined = `${r.title} ${r.snippet}`.toLowerCase();
    if ((combined.match(/[\u4e00-\u9fff]/g) || []).length < 4) continue;

    let price = null;
    for (const p of [/[¥￥]\s*(\d+[\.\d]*)/g, /(\d+[\.\d]*)\s*[元块]/g]) {
      const m = p.exec(r.snippet); if (m) { price = parseFloat(m[1]); break; }
    }
    if (price && (price < (+priceMin||0)*0.5 || price > (+priceMax||9999)*2)) price = null;

    products.push({
      name: r.title, brand: '', origin: '', price, platform: r.platform,
      spec: '', salesVolume: '', company: '', shopUrl: '', sourceUrl: r.url,
      score: 4, summary: r.snippet.substring(0, 100), dataQuality: 'snippet',
    });
  }
  return products.slice(0, 20);
}

// ═══════════════════ 健康检查 ═══════════════════

async function checkSearXNG() {
  try {
    const resp = await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
    return resp.ok;
  } catch { return false; }
}

function detectPlatform(linkUrl) {
  if (!linkUrl) return '搜索发现';
  if (/taobao\.com|tmall\.com/i.test(linkUrl)) return '淘宝';
  if (/jd\.com/i.test(linkUrl)) return '京东';
  if (/1688\.com/i.test(linkUrl)) return '1688';
  if (/pinduoduo\.com|yangkeduo\.com/i.test(linkUrl)) return '拼多多';
  if (/smzdm\.com/i.test(linkUrl)) return '什么值得买';
  if (/zhihu\.com/i.test(linkUrl)) return '知乎';
  if (/xiaohongshu\.com/i.test(linkUrl)) return '小红书';
  return '全网搜索';
}

// ═══════════════════ 搜索主流程 v1.4 ═══════════════════

async function autoSearch(categoryName, keywords, originPref, priceMin, priceMax) {
  const start = Date.now();
  const engineMode = getEngineMode();
  let searxngAlive = false;
  let dldProducts = null;
  let searxngResults = [];

  // 步骤1: 搜索词优化
  const tag = llmEnabled ? `LLM(${activeLLM.id})` : '直接';
  console.log(`[engine] 📝 步骤1: ${tag} 搜索词优化`);
  const searchQueries = await optimizeQueriesWithLLM(categoryName, keywords, originPref);
  console.log(`[engine]    → ${searchQueries.length} 条搜索词`);

  // 步骤2: 并发搜索（1688 + SearXNG 同时进行）
  console.log(`[engine] 🔍 步骤2: 并发搜索（1688 + SearXNG）`);

  // 1688 搜索（每个优化的搜索词都搜，选前5个词）
  if (dldEnabled) {
    const dldPromises = searchQueries.slice(0, 5).map(kw =>
      search1688(kw, priceMin, priceMax, 10)
    );
    const dldResults = await Promise.all(dldPromises);
    // 合并去重
    const seen = new Set();
    const allDld = [];
    for (const r of dldResults) {
      if (!r) continue;
      for (const p of r.products) {
        const key = p.name.substring(0, 30);
        if (!seen.has(key)) { seen.add(key); allDld.push(p); }
      }
    }
    if (allDld.length > 0) {
      dldProducts = allDld;
      console.log(`[engine]    1688: ${allDld.length}个去重产品`);
    }
  }

  // SearXNG 搜索（选前3个词，主要用于市场口碑）
  searxngAlive = await checkSearXNG();
  if (searxngAlive && searchQueries.length > 0) {
    const sxPromises = searchQueries.slice(0, 3).map(kw => searchSearXNG(kw, 6));
    const sxResults = await Promise.all(sxPromises);
    for (const r of sxResults) searxngResults.push(...r);
    console.log(`[engine]    SearXNG: ${searxngResults.length} 条市场信息`);
  }

  // 步骤3: 综合分析或直接返回
  let products = [];
  let analysisSummary = '';

  if (dldProducts && dldProducts.length > 0) {
    // 1688 数据质量已经很高，跳过 LLM 分析，直接格式化输出
    console.log(`[engine] ⚡ 直接使用1688数据（${dldProducts.length}个产品）`);
    products = dldProducts.slice(0, 20).map(p => ({
      name: p.name,
      brand: '',
      origin: extractOrigin(p.name, p.company, originPref),
      price: p.price,
      consignPrice: p.consignPrice,
      platform: '1688',
      spec: '',
      salesVolume: p.sales30d ? `月销${p.sales30d}笔` : '',
      company: p.company,
      shopUrl: p.shopUrl || '',
      sourceUrl: p.productUrl || '',
      score: Math.min(10, Math.round(p.sales30d / 100 + 5)),
      summary: `${p.company} · 批发 ¥${p.price}${p.consignPrice ? ' / 代发 ¥'+p.consignPrice : ''}`,
      dataQuality: 'dld(real)',
      deliveryTime: p.deliveryTime || '',
      quantityBegin: p.quantityBegin || 0,
      salesOrderCount: p.sales30d || 0,
      salesQuantity: p.salesVolume30d || 0,
      estimatedRevenue: p.estRevenue || 0,
    }));
    analysisSummary = `1688平台${categoryName}真实数据，共${dldProducts.length}条去重产品。`;
  } else if (searxngResults.length > 0) {
    console.log(`[engine] ⚡ 仅SearXNG搜索（无1688 API Key）`);
    // 有LLM时用LLM提取，没有则正则
    if (llmEnabled) {
      const extracted = await extractProductsWithLLM(categoryName, priceMin, priceMax, searxngResults);
      if (extracted && extracted.length >= 2) products = extracted;
      else products = extractWithRegex(searxngResults, priceMin, priceMax);
    } else {
      products = extractWithRegex(searxngResults, priceMin, priceMax);
    }
  } else {
    console.log(`[engine] ⚠️ 无搜索结果`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const modeLabel = dldEnabled ? (llmEnabled ? `1688 + SearXNG + ${activeLLM.name}` : '1688 + SearXNG')
    : (llmEnabled ? `SearXNG + ${activeLLM.name}` : 'SearXNG 基础模式');
  console.log(`[engine] ✅ ${modeLabel}: ${products.length}个产品 | ${elapsed}s`);

  return {
    products: products.slice(0, 30),
    sources: searchQueries.slice(0, 5),
    summary: analysisSummary,
    generated: false,
    engineMode,
  };
}

// ═══════════════════ LLM 提取（仅SearXNG模式，无1688时用） ═══════════════════

async function extractProductsWithLLM(categoryName, priceMin, priceMax, rawResults) {
  if (!llmEnabled) return null;

  const seenUrls = new Set();
  const inputs = [];
  for (const r of rawResults) {
    if (seenUrls.has(r.url)) continue;
    seenUrls.add(r.url);
    inputs.push(r);
    if (inputs.length >= 25) break;
  }
  if (inputs.length < 3) return null;

  const itemsText = inputs.map((r, i) =>
    `[${i+1}] ${r.platform} | ${r.title} | ${r.snippet}`
  ).join('\n');

  const prompt = `提取关于"${categoryName}"的产品信息。价格参考：¥${priceMin||0}-¥${priceMax||9999}

搜索结果：${itemsText}

输出JSON：{"products":[{"id":编号,"name":"产品名","brand":"品牌","price":数字或null,"platform":"平台","spec":"规格","score":1-10}]}
规则：有产品信息就提取，不要编造。`;

  try {
    const { content, provider } = await callLLM([{ role: 'user', content: prompt }], 3000, 0.3);
    const parsed = JSON.parse(content);
    if (!parsed.products || parsed.products.length === 0) return null;

    return parsed.products.map(p => {
      const src = inputs[p.id - 1] || {};
      return {
        name: p.name || src.title || '', brand: p.brand || '', origin: '',
        price: p.price || null, platform: p.platform || src.platform || '',
        spec: p.spec || '', salesVolume: '', company: '', shopUrl: '',
        sourceUrl: src.url || '', score: p.score || 5, summary: '',
        dataQuality: `llm_${provider}`,
      };
    });
  } catch (e) {
    console.error(`[engine] 提取失败: ${e.message}`);
    return null;
  }
}

// ═══════════════════ HTTP 路由 ═══════════════════

const server = http.createServer((req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // POST /api/search/auto
  if (req.method === 'POST' && pathname === '/api/search/auto') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      let params, id;
      try { params = JSON.parse(body || '{}'); id = genId(); }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Invalid JSON' })); return; }

      const engineMode = getEngineMode();
      console.log(`[engine] 📩 ${params.categoryName || params.category} | ${(params.searchKeywords||[]).slice(0,3).join(', ')} | ${engineMode}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id, status: 'searching', engineMode }));

      const rf = path.join(REQUESTS_DIR, `${id}.json`);
      fs.writeFileSync(rf, JSON.stringify({
        id, timestamp: new Date().toISOString(), status: 'searching',
        category: params.category || params.categoryName,
        categoryName: params.categoryName, searchKeywords: params.searchKeywords || [],
        originPref: params.originPref || '', priceFilter: params.priceFilter || { min: 0, max: 9999 },
      }, null, 2));

      try {
        const result = await Promise.race([
          autoSearch(params.categoryName || params.category, params.searchKeywords || [],
            params.originPref || '', params.priceFilter?.min || 0, params.priceFilter?.max || 9999),
          new Promise((_, rej) => setTimeout(() => rej(new Error('全局超时(120s)')), 120000))
        ]);

        const llmProvider = llmEnabled ? { id: activeLLM.id, name: activeLLM.name, cost: activeLLM.cost } : null;

        fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify({
          id, timestamp: new Date().toISOString(),
          products: result.products,
          sources: result.sources,
          summary: result.summary || '',
          generated: result.generated || false,
          engineMode: result.engineMode,
          llmEnhanced: llmEnabled,
          llmProvider,
          dldEnabled,
          searchMeta: { category: params.categoryName, keywords: params.searchKeywords },
        }, null, 2));

        fs.writeFileSync(rf, JSON.stringify({ id, timestamp: new Date().toISOString(), status: 'completed',
          category: params.category, keywords: params.searchKeywords }, null, 2));

      } catch (e) {
        console.error(`[engine] ❌ ${id.slice(-8)}:`, e.message);
        fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify({
          id, timestamp: new Date().toISOString(), products: [], sources: [], error: e.message,
        }, null, 2));
        fs.writeFileSync(rf, JSON.stringify({ id, timestamp: new Date().toISOString(), status: 'error', error: e.message }, null, 2));
      }
    });
    return;
  }

  // GET /api/status/:id
  if (req.method === 'GET' && pathname.startsWith('/api/status/')) {
    const id = pathname.replace('/api/status/', '');
    const rf = path.join(REQUESTS_DIR, `${id}.json`);
    if (!fs.existsSync(rf)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
    const rd = JSON.parse(fs.readFileSync(rf, 'utf-8'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)) ? 'completed' : (rd.status || 'pending'), request: rd }));
    return;
  }

  // GET /api/results/:id
  if (req.method === 'GET' && pathname.startsWith('/api/results/')) {
    const id = pathname.replace('/api/results/', '');
    const rf = path.join(RESULTS_DIR, `${id}.json`);
    if (fs.existsSync(rf)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(fs.readFileSync(rf, 'utf-8'));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not ready' }));
    }
    return;
  }

  // GET /api/health
  if (req.method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok', uptime: process.uptime(), engineMode: getEngineMode(),
      dldEnabled,
      llmProvider: llmEnabled ? { id: activeLLM.id, name: activeLLM.name, cost: activeLLM.cost } : null,
      availableProviders: LLM_PROVIDERS.map(p => ({
        id: p.id, name: p.name, cost: p.cost,
        configured: !!activeProviders.find(ap => ap.id === p.id),
        active: llmEnabled && activeLLM.id === p.id,
      })),
    }));
    return;
  }

  // Static
  let fp = path.join(STATIC_DIR, pathname === '/' ? 'index.html' : pathname);
  serveStatic(res, fp);
});

// ═══════════════════ 启动 ═══════════════════

process.on('uncaughtException', err => console.error('[engine] ❌', err.message));
process.on('unhandledRejection', reason => console.error('[engine] ❌ Promise:', reason));

async function startup() {
  // 等待SearXNG就绪（不阻塞，仅做检测）
  for (let i = 0; i < 10; i++) {
    if (await checkSearXNG()) {
      console.log(`[engine] ✅ SearXNG 已就绪`);
      return;
    }
    console.log(`[engine] ⏳ 等待 SearXNG... (${i+1}/10)`);
    await sleep(2000);
  }
  console.log(`[engine] ⚠️ SearXNG 未就绪（1688数据仍可用）`);
}

startup().then(() => {
  server.listen(PORT, '0.0.0.0', () => {});
});
