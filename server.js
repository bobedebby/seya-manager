if (process.env.NODE_ENV !== 'production') { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; }
if (process.env.NODE_ENV !== 'production') { require('dotenv').config(); }
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { Jimp } = require('jimp');
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.get('/curation', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'curation.html'));
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ─── 品項名稱正規化對應表 ────────────────────────────────────────────
// POS 顯示名稱 → products 表的 name 欄位
const PRODUCT_NAME_MAP = {
  '單品黑咖啡':        'Today單品',
  '重拿鐵':            '重拿鐵咖啡',
  '單品豆1/4磅':       '配方豆1/4磅',
  '柚香灑酒拿鐵':      '柚香灑酒拿鐵',    // 強制對應，防止字元比對失敗
  '柚香灑酒摩卡':      '柚香灑酒摩卡',    // 強制對應，防止字元比對失敗
  '果乾磅蛋糕':        '山午磅蛋糕',
  '晨醞厚吐司-明太子':  '晨醞厚吐司',
  '晨醞厚吐司-藍莓奶酪': '晨醞厚吐司',
  // 柚香灑酒 OCR 亂字變體
  '柚香瀧酒拿鐵':      '柚香灑酒拿鐵',
  '柚香麗酒拿鐵':      '柚香灑酒拿鐵',
  '柚香瀧酒摩卡':      '柚香灑酒摩卡',
  '柚香麗酒摩卡':      '柚香灑酒摩卡',
  // 其他 OCR 亂字變體
  '酣韻芝麻拿鐵':      '醇韻芝麻拿鐵',
  '酩韻芝麻拿鐵':      '醇韻芝麻拿鐵',
  '初日黑咖啡-墨比':   '初日黑咖啡-墨止',
  // 晨霧厚土司 OCR 亂字變體
  '晨霧厚土司-花生':   '晨醞厚吐司',
  '晨霧厚土司-蒜香':   '晨醞厚吐司',
  '晨霧厚土司-奶酥':   '晨醞厚吐司',
  '晨霧厚土司-巧克力':  '晨醞厚吐司',
  '晨霧厚土司-明太子':  '晨醞厚吐司',
  // 晨曦厚土司 OCR 亂字變體
  '晨曦厚土司-花生':   '晨醞厚吐司',
  '晨曦厚土司-蒜香':   '晨醞厚吐司',
  '晨曦厚土司-奶酥':   '晨醞厚吐司',
  '晨曦厚土司-巧克力':  '晨醞厚吐司',
  // 晨醫厚土司 OCR 亂字變體
  '晨醫厚土司-花生':   '晨醞厚吐司',
  '晨醫厚土司-蒜香':   '晨醞厚吐司',
};

// POS 名稱含以下關鍵字時 → 對應到 products 表的「晨醞厚吐司」（成本40，售價45）
const TOAST_KEYWORDS = ['晨醞', '厚土司', '厚吐司', '吐司'];

/**
 * 將 POS 品項名稱解析成 { resolvedName, fixedCost }
 * fixedCost = null 表示需要查 products 表
 */

/**
 * 將 POS 品項名稱解析成 { resolvedName, fixedCost }
 * fixedCost = null 表示需要查 products 表
 */
function resolveProductName(posName) {
  // 吐司類 → 統一對應到 products 表的「晨醞厚吐司」
  for (const kw of TOAST_KEYWORDS) {
    if (posName.includes(kw)) return { resolvedName: '晨醞厚吐司', fixedCost: null };
  }
  // 一般別名對應
  const mapped = PRODUCT_NAME_MAP[posName] || posName;
  return { resolvedName: mapped, fixedCost: null };
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Seya Manager 運作中' });
});

// ─── Claude Vision 解析 ──────────────────────────────────────────────
async function analyzeImageWithClaude(buffer, mimeType, imageType) {
  const base64Image = buffer.toString('base64');

  const prompts = {
    sales_ranking: `這是一張商品銷售排行榜收據。格式是：名稱、銷售量、單價（累積金額，請忽略）、小計（累積金額，請忽略）。
請只擷取品項名稱與銷售量，整理成 JSON，只回傳 JSON 不要其他文字：
{
  "sale_date": "YYYY-MM-DD",
  "items": [
    { "product_name": "品項名稱", "qty_sold": 數量 }
  ]
}`,
    payment_detail: `這是一張每日櫃檯結帳明細表。請找底部的總計金額區塊，擷取以下資訊，整理成 JSON，只回傳 JSON 不要其他文字：
{
  "sale_date": "YYYY-MM-DD",
  "total_revenue": 總結金額數字,
  "cash_amount": 現金金額（總結金額減去所有刷卡金額）,
  "card_amount": VISA金額加MASTER金額加JCB金額加運通金額的總和,
  "other_amount": 其他金額
}`,
    period_summary: `這是一張交班總表收據。請擷取以下資訊，整理成 JSON，只回傳 JSON 不要其他文字：

注意：
- 折價券金額：收據上如有「折價券」欄位則取其數字，沒有則為0
- 折讓金額：收據上「折讓金額」欄位的數字，沒有則為0
- 實際總營業額 = 營業金額 - 折價券金額 - 折讓金額
- 付現金額：收據上「付現金額」欄位
- 刷卡金額：收據上「刷卡金額」欄位

{
  "sale_date": "YYYY-MM-DD",
  "gross_revenue": 營業金額數字,
  "discount_voucher": 折價券金額數字（沒有則為0）,
  "discount_amount": 折讓金額數字（沒有則為0）,
  "total_revenue": 營業金額減去折價券金額再減去折讓金額的結果,
  "cash_amount": 付現金額數字,
  "card_amount": 刷卡金額數字,
  "periods": [
    { "time": "時段數字", "amount": 營業額數字, "customers": 客數數字 }
  ]
}`
  };

  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
      { type: 'text', text: prompts[imageType] }
    ]
  }];
  console.log(`[analyze] ${imageType} 傳送 media_type=${mimeType} base64長度=${base64Image.length}`);

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 2000, messages })
  });

  const data = await response.json();
  console.log(`[analyze] ${imageType} HTTP=${response.status} 原始回傳:`, JSON.stringify(data).substring(0, 500));
  if (!data.content) throw new Error(`Claude API 錯誤: ${JSON.stringify(data)}`);
  const text = data.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── 圖片解析 ────────────────────────────────────────────────────────
app.post('/api/analyze-multi', upload.array('images', 3), async (req, res) => {
  try {
    const files = req.files;
    const types = req.body.types;
    const typeArray = Array.isArray(types) ? types : [types];

    console.log(`[analyze-multi] 收到 ${files ? files.length : 0} 個檔案, types=${JSON.stringify(types)}`);
    (files || []).forEach((f, i) => {
      console.log(`[analyze-multi] 檔案[${i}] originalname=${f.originalname} mimetype=${f.mimetype} size=${f.size}bytes`);
    });

    const results = {};
    const errors = {};

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const imageType = typeArray[i];
      try {
        // 後端壓縮：超過 1MB 就用 jimp 縮到 1200px、品質 70%
        let buffer = file.buffer;
        if (buffer.length > 1024 * 1024) {
          const img = await Jimp.fromBuffer(buffer);
          if (img.width > 800 || img.height > 800) {
            img.scaleToFit({ w: 800, h: 800 });
          }
          buffer = await img.getBuffer('image/jpeg', { quality: 60 });
          console.log(`[analyze-multi] ${imageType} 壓縮後 ${buffer.length}bytes`);
        }
        const parsed = await analyzeImageWithClaude(buffer, 'image/jpeg', imageType);
        results[imageType] = parsed;
      } catch (e) {
        console.error(`[analyze-multi] ${imageType} 解析失敗:`, e.message);
        errors[imageType] = e.message;
      }
    }

    const summary = results.period_summary;
    const payment = results.payment_detail;
    const sales   = results.sales_ranking;

    const merged = {
      sale_date:        summary?.sale_date || payment?.sale_date || sales?.sale_date,
      items:            sales?.items || [],
      gross_revenue:    summary?.gross_revenue || 0,
      discount_voucher: summary?.discount_voucher || 0,
      discount_amount:  summary?.discount_amount || 0,
      total_revenue:    summary?.total_revenue || payment?.total_revenue || 0,
      cash_amount:      summary?.cash_amount  || payment?.cash_amount  || 0,
      card_amount:      summary?.card_amount  || payment?.card_amount  || 0,
      other_amount:     payment?.other_amount || 0,
      periods:          summary?.periods || [],
      parse_errors:     Object.keys(errors).length > 0 ? errors : null
    };

    res.json({ success: true, data: merged });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 儲存每日資料（自動回填成本） ────────────────────────────────────
app.post('/api/save-daily', async (req, res) => {
  try {
    const {
      sale_date, items, total_revenue,
      gross_revenue, discount_voucher, discount_amount,
      cash_amount, card_amount, other_amount,
      is_complete
    } = req.body;

    // 1. 無條件清除該日期舊數據（確保重複上傳會完整覆蓋，不疊加）
    const { error: delCashError } = await supabase
      .from('daily_cash')
      .delete()
      .eq('sale_date', sale_date);
    if (delCashError) throw delCashError;

    const { error: delSalesError } = await supabase
      .from('daily_sales')
      .delete()
      .eq('sale_date', sale_date);
    if (delSalesError) throw delSalesError;

    // 2. 寫入新的 daily_cash
    const { error: cashError } = await supabase
      .from('daily_cash')
      .insert({ sale_date, total_revenue, cash_amount, card_amount, other_amount, is_complete: is_complete !== false, discount_voucher: discount_voucher || 0, discount_amount: discount_amount || 0 });

    if (cashError) throw cashError;

    // 3. 寫入新的 daily_sales
    if (items && items.length > 0) {

      const salesData = items.map(item => ({
        sale_date,
        product_name: item.product_name,
        qty_sold:     item.qty_sold
      }));

      const { error: salesError } = await supabase
        .from('daily_sales')
        .insert(salesData);

      if (salesError) throw salesError;

      // 4. 用 SQL UPDATE JOIN 在資料庫層直接回填成本，完全繞過 Node 字串比對問題
      const { error: fillError } = await supabase.rpc('backfill_daily_sales_cost', {
        p_sale_date: sale_date
      });
      if (fillError) console.warn('成本回填 RPC 失敗:', fillError.message);

      // 5. 補充回填：查出仍未填成本的品項（gross_profit 為 null 或 0）
      //    用 unit_cost（優先）或 cost_price 補填，同時處理 PRODUCT_NAME_MAP 別名
      const { data: savedRows } = await supabase
        .from('daily_sales')
        .select('product_name, qty_sold, gross_profit, cost')
        .eq('sale_date', sale_date);

      for (const row of (savedRows || [])) {
        // gross_profit 與 cost 都已填入才跳過，避免 RPC 以 cost=0 算出虛假正毛利
        if (row.gross_profit != null && row.gross_profit > 0 && row.cost != null && row.cost > 0) continue;

        const { resolvedName } = resolveProductName(row.product_name);
        const { data: p } = await supabase
          .from('products')
          .select('sell_price, unit_cost, cost_price')
          .eq('name', resolvedName)
          .single();
        if (!p) continue;

        // 優先用 unit_cost，沒有再用 cost_price
        const costPerUnit = parseFloat(p.unit_cost ?? p.cost_price) || 0;
        if (costPerUnit === 0) continue;

        const unit_price   = parseFloat(p.sell_price) || 0;
        const cost         = costPerUnit * row.qty_sold;
        const gross_profit = unit_price * row.qty_sold - cost;

        await supabase
          .from('daily_sales')
          .update({ unit_price, cost, gross_profit })
          .eq('sale_date', sale_date)
          .eq('product_name', row.product_name);
      }
    }

    res.json({ success: true, message: '資料已儲存' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 每日毛利報表 ────────────────────────────────────────────────────
app.get('/api/daily-report/:date', async (req, res) => {
  try {
    const { date } = req.params;

    const { data: sales, error: salesError } = await supabase
      .from('daily_sales')
      .select('product_name, qty_sold, unit_price, cost, gross_profit')
      .eq('sale_date', date)
      .order('gross_profit', { ascending: false });

    if (salesError) throw salesError;

    const { data: cash, error: cashError } = await supabase
      .from('daily_cash')
      .select('*')
      .eq('sale_date', date)
      .single();

    if (cashError && cashError.code !== 'PGRST116') throw cashError;

    const total_cost              = sales.reduce((sum, s) => sum + (s.cost         || 0), 0);
    const items_gross_profit      = sales.reduce((sum, s) => sum + (s.gross_profit || 0), 0);
    const total_revenue           = cash?.total_revenue    || 0;
    const discount_voucher        = cash?.discount_voucher || 0;
    const discount_amount         = cash?.discount_amount  || 0;
    const total_gross_profit      = items_gross_profit - discount_voucher - discount_amount;
    const margin_pct = total_revenue > 0
      ? Math.round(total_gross_profit / total_revenue * 1000) / 10
      : 0;

    res.json({
      success: true,
      data: {
        sale_date: date,
        total_revenue,
        total_cost,
        total_gross_profit,
        discount_voucher,
        discount_amount,
        margin_pct,
        cash_amount:  cash?.cash_amount  || 0,
        card_amount:  cash?.card_amount  || 0,
        items: sales
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── CSV 匯出 ────────────────────────────────────────────────────────
app.get('/api/export-csv', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    if (!start_date || !end_date) {
      return res.status(400).json({ error: '請提供 start_date 和 end_date' });
    }

    const { data, error } = await supabase
      .from('daily_sales')
      .select('sale_date, product_name, qty_sold, unit_price, cost, gross_profit')
      .gte('sale_date', start_date)
      .lte('sale_date', end_date)
      .order('sale_date', { ascending: true })
      .order('gross_profit', { ascending: false });

    if (error) throw error;

    const headers = ['sale_date', 'product_name', 'qty_sold', 'unit_price', 'cost', 'gross_profit'];
    const rows = data.map(row =>
      headers.map(h => {
        const v = row[h] ?? '';
        // 若含逗號或引號則加引號包裹
        return String(v).includes(',') || String(v).includes('"')
          ? '"' + String(v).replace(/"/g, '""') + '"'
          : String(v);
      }).join(',')
    );

    // 加 BOM 讓 Excel 正確辨識 UTF-8
    const csv = '﻿' + headers.join(',') + '\n' + rows.join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="seya-sales-${start_date}-${end_date}.csv"`);
    res.send(csv);

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ─── 數據覆蓋狀況 ────────────────────────────────────────────────────
app.get('/api/data-coverage', async (req, res) => {
  try {
    const [{ data: cashData, error: cashError }, { data: nbData, error: nbError }] = await Promise.all([
      supabase.from('daily_cash').select('sale_date, is_complete').order('sale_date', { ascending: true }),
      supabase.from('non_business_days').select('date'),
    ]);
    if (cashError) throw cashError;
    if (nbError) throw nbError;

    const dateMap = {};
    (cashData || []).forEach(r => {
      dateMap[r.sale_date] = r.is_complete === false ? 'incomplete' : 'complete';
    });
    (nbData || []).forEach(r => {
      if (!dateMap[r.date]) dateMap[r.date] = 'non_business';
    });
    res.json({ success: true, dateMap });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/non-business-day', async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ success: false, error: '請提供 date' });
    const { error } = await supabase.from('non_business_days').upsert({ date });
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.delete('/api/non-business-day/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const { error } = await supabase.from('non_business_days').delete().eq('date', date);
    if (error) throw error;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── AI 營業報告 ─────────────────────────────────────────────────────
app.post('/api/daily-ai-report', async (req, res) => {
  try {
    const { sale_date, total_revenue, margin_pct, items, periods } = req.body;

    const topItems = (items || []).slice(0, 5)
      .map((item, i) => `${i + 1}. ${item.product_name}（${item.qty_sold} 杯，毛利 $${item.gross_profit || 0}）`)
      .join('\n');

    const periodText = (periods || [])
      .map(p => `${p.time}：$${p.amount}`)
      .join('、') || '（無時段資料）';

    const prompt = `你是一位咖啡廳顧問，請根據以下今日營業數據，用繁體中文撰寫一份簡短的每日營業報告。

【今日數據】
日期：${sale_date}
總營業額：$${total_revenue}
毛利率：${margin_pct}%
品項銷售排行（前5名）：
${topItems}
時段營業額：${periodText}

請輸出以下三個段落，每段 2～3 句，不需標題以外的格式：

**今日總結**
（簡述今日整體表現，提及營業額與毛利率是否達標或偏低）

**值得注意的訊號**
（從品項排行或時段分佈中找出一個具體現象，例如某品項銷售異常、某時段特別冷清）

**明日建議**
（根據今日數據，提出一個具體可執行的建議，例如推某品項、調整備料量）`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok || !data.content) {
      console.error('[AI報告] Claude API 錯誤:', JSON.stringify(data));
      throw new Error('Claude API 錯誤: ' + (data?.error?.message || JSON.stringify(data)));
    }

    const report = data.content[0].text.trim();
    res.json({ success: true, report });

  } catch (error) {
    console.error('[AI報告] 失敗:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── 週/月報 輔助函數 ─────────────────────────────────────────────────
function getWeekBounds(dateStr) {
  const d = new Date(dateStr);
  const day = d.getDay(); // 0=Sun
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d); mon.setDate(d.getDate() + diffToMon);
  const sat = new Date(mon); sat.setDate(mon.getDate() + 5);
  return { start: mon.toISOString().slice(0, 10), end: sat.toISOString().slice(0, 10) };
}

function aggregateItems(sales) {
  const map = {};
  (sales || []).forEach(r => {
    const name = resolveProductName(r.product_name).resolvedName;
    if (!map[name]) map[name] = { qty: 0, revenue: 0, profit: 0 };
    map[name].qty     += r.qty_sold || 0;
    map[name].revenue += (r.unit_price || 0) * (r.qty_sold || 0);
    map[name].profit  += r.gross_profit || 0;
  });
  return Object.entries(map).map(([name, v]) => ({ name, ...v }));
}

// ─── 週報 ─────────────────────────────────────────────────────────────
app.get('/api/weekly-report', async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: '請提供 date' });

    const { start, end } = getWeekBounds(date);
    const prevDate = new Date(start); prevDate.setDate(prevDate.getDate() - 1);
    const prev = getWeekBounds(prevDate.toISOString().slice(0, 10));

    const [{ data: sales }, { data: cash }, { data: prevSales }, { data: prevCash }] = await Promise.all([
      supabase.from('daily_sales').select('sale_date,product_name,qty_sold,unit_price,gross_profit').gte('sale_date', start).lte('sale_date', end),
      supabase.from('daily_cash').select('sale_date,total_revenue').gte('sale_date', start).lte('sale_date', end),
      supabase.from('daily_sales').select('gross_profit').gte('sale_date', prev.start).lte('sale_date', prev.end),
      supabase.from('daily_cash').select('total_revenue').gte('sale_date', prev.start).lte('sale_date', prev.end),
    ]);

    const total_revenue      = (cash || []).reduce((s, r) => s + (r.total_revenue || 0), 0);
    const total_gross_profit = (sales || []).reduce((s, r) => s + (r.gross_profit || 0), 0);
    const margin_pct  = total_revenue > 0 ? Math.round(total_gross_profit / total_revenue * 1000) / 10 : 0;
    const days_count  = (cash || []).length;
    const avg_order_value = days_count > 0 ? Math.round(total_revenue / days_count) : 0;

    // Daily breakdown Mon-Sat
    const dailyMap = {};
    (cash  || []).forEach(r => { dailyMap[r.sale_date] = { revenue: r.total_revenue || 0, profit: 0 }; });
    (sales || []).forEach(r => { if (!dailyMap[r.sale_date]) dailyMap[r.sale_date] = { revenue: 0, profit: 0 }; dailyMap[r.sale_date].profit += r.gross_profit || 0; });

    const daily_breakdown = [];
    const startD = new Date(start);
    for (let i = 0; i < 6; i++) {
      const d = new Date(startD); d.setDate(startD.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      daily_breakdown.push({ date: ds, revenue: dailyMap[ds]?.revenue || 0, profit: dailyMap[ds]?.profit || 0 });
    }

    const items = aggregateItems(sales);
    const top5_revenue = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    const top5_profit  = [...items].sort((a, b) => b.profit  - a.profit ).slice(0, 5);

    const prev_revenue = (prevCash  || []).reduce((s, r) => s + (r.total_revenue || 0), 0);
    const prev_profit  = (prevSales || []).reduce((s, r) => s + (r.gross_profit  || 0), 0);
    const prev_days    = (prevCash  || []).length;

    res.json({ success: true, data: {
      week_start: start, week_end: end,
      total_revenue, total_gross_profit, margin_pct, avg_order_value,
      daily_breakdown, top5_revenue, top5_profit,
      prev_week: {
        total_revenue: prev_revenue,
        margin_pct: prev_revenue > 0 ? Math.round(prev_profit / prev_revenue * 1000) / 10 : 0,
        avg_order_value: prev_days > 0 ? Math.round(prev_revenue / prev_days) : 0
      }
    }});
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── 月報 ─────────────────────────────────────────────────────────────
app.get('/api/monthly-report', async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: '請提供 month' });

    const start = month + '-01';
    const endD  = new Date(month + '-01'); endD.setMonth(endD.getMonth() + 1); endD.setDate(0);
    const end   = endD.toISOString().slice(0, 10);

    const prevD  = new Date(month + '-01'); prevD.setMonth(prevD.getMonth() - 1);
    const prevM  = prevD.toISOString().slice(0, 7);
    const prevS  = prevM + '-01';
    const prevED = new Date(prevS); prevED.setMonth(prevED.getMonth() + 1); prevED.setDate(0);
    const prevE  = prevED.toISOString().slice(0, 10);

    const [{ data: sales }, { data: cash }, { data: prevSales }, { data: prevCash }, { data: products }] = await Promise.all([
      supabase.from('daily_sales').select('sale_date,product_name,qty_sold,unit_price,gross_profit').gte('sale_date', start).lte('sale_date', end),
      supabase.from('daily_cash').select('sale_date,total_revenue').gte('sale_date', start).lte('sale_date', end),
      supabase.from('daily_sales').select('gross_profit').gte('sale_date', prevS).lte('sale_date', prevE),
      supabase.from('daily_cash').select('total_revenue').gte('sale_date', prevS).lte('sale_date', prevE),
      supabase.from('products').select('name,category'),
    ]);

    const catMap = {};
    (products || []).forEach(p => { catMap[p.name] = p.category || '其他'; });

    const total_revenue      = (cash  || []).reduce((s, r) => s + (r.total_revenue || 0), 0);
    const total_gross_profit = (sales || []).reduce((s, r) => s + (r.gross_profit  || 0), 0);
    const margin_pct      = total_revenue > 0 ? Math.round(total_gross_profit / total_revenue * 1000) / 10 : 0;
    const days_count      = (cash || []).length;
    const avg_order_value = days_count > 0 ? Math.round(total_revenue / days_count) : 0;

    // Weekly breakdown
    const weekMap = {};
    (cash  || []).forEach(r => { const k = getWeekBounds(r.sale_date); const wk = k.start; if (!weekMap[wk]) weekMap[wk] = { week_start: k.start, week_end: k.end, revenue: 0, profit: 0 }; weekMap[wk].revenue += r.total_revenue || 0; });
    (sales || []).forEach(r => { const k = getWeekBounds(r.sale_date); const wk = k.start; if (!weekMap[wk]) weekMap[wk] = { week_start: k.start, week_end: k.end, revenue: 0, profit: 0 }; weekMap[wk].profit  += r.gross_profit  || 0; });
    const weekly_breakdown = Object.values(weekMap).sort((a, b) => a.week_start.localeCompare(b.week_start));

    // Category breakdown
    const catRevMap = {};
    (sales || []).forEach(r => {
      const resolved = resolveProductName(r.product_name).resolvedName;
      const cat = catMap[r.product_name] || catMap[resolved] || '其他';
      if (!catRevMap[cat]) catRevMap[cat] = { revenue: 0, profit: 0 };
      catRevMap[cat].revenue += (r.unit_price || 0) * (r.qty_sold || 0);
      catRevMap[cat].profit  += r.gross_profit || 0;
    });
    const category_breakdown = Object.entries(catRevMap)
      .map(([category, v]) => ({ category, ...v, pct: total_revenue > 0 ? Math.round(v.revenue / total_revenue * 1000) / 10 : 0 }))
      .filter(c => c.revenue > 0).sort((a, b) => b.revenue - a.revenue);

    const items = aggregateItems(sales);
    const top5_revenue   = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    const top5_profit    = [...items].sort((a, b) => b.profit  - a.profit ).slice(0, 5);
    const bottom5_profit = [...items].filter(i => i.profit > 0).sort((a, b) => a.profit - b.profit).slice(0, 5);

    const prev_revenue = (prevCash  || []).reduce((s, r) => s + (r.total_revenue || 0), 0);
    const prev_profit  = (prevSales || []).reduce((s, r) => s + (r.gross_profit  || 0), 0);

    res.json({ success: true, data: {
      month, start, end,
      total_revenue, total_gross_profit, margin_pct, avg_order_value,
      weekly_breakdown, category_breakdown,
      top5_revenue, top5_profit, bottom5_profit,
      prev_month: { total_revenue: prev_revenue, margin_pct: prev_revenue > 0 ? Math.round(prev_profit / prev_revenue * 1000) / 10 : 0 }
    }});
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── 週報 AI 小結 ─────────────────────────────────────────────────────
app.post('/api/monthly-ai-report', async (req, res) => {
  try {
    const { month, total_revenue, margin_pct, prev_month, category_breakdown, top5_profit, top5_revenue } = req.body;

    const catLines = (category_breakdown || []).map(c => c.category + ' ' + c.pct + '% $' + Math.round(c.revenue)).join('、');
    const prevRev  = prev_month?.total_revenue || 0;
    const prevIncomplete = prevRev < total_revenue * 0.3;

    const comparisonInstruction = prevIncomplete
      ? `上月數據不完整（僅 $${prevRev}），請在第一行說明「上月數據尚不完整，本月為有效基準月」，不做月比月數字比較，分析專注於本月表現。`
      : `上月：$${prevRev}，${prev_month?.margin_pct || 0}%，請在第一行與上月比較。`;

    const prompt = `你是咖啡廳顧問，根據以下月報，用繁體中文輸出剛好三行，不要任何標題、數字編號或符號：
第一行：本月一句話總結（含營業額、毛利率評估）
第二行：品類結構觀察——指出佔比最高與最低品類，說明結構是否健康，若有明顯失衡給出具體原因
第三行：一個具體可執行的下月調整建議——指出哪個品項或品類需要行動，以及具體怎麼做

${comparisonInstruction}

月份：${month}
月營業額：$${total_revenue}，毛利率：${margin_pct}%
品類分布：${catLines}
毛利前五：${(top5_profit || []).map(i => i.name + '$' + Math.round(i.profit)).join('、')}
營收前五：${(top5_revenue || []).map(i => i.name + '$' + Math.round(i.revenue)).join('、')}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    if (!response.ok || !data.content) throw new Error(JSON.stringify(data));
    const lines = data.content[0].text.trim().split('\n').filter(l => l.trim());
    res.json({ success: true, summary: lines[0] || '', category_note: lines[1] || '', suggestion: lines[2] || '' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/weekly-ai-report', async (req, res) => {
  try {
    const { week_start, week_end, total_revenue, margin_pct, top5_profit, top5_revenue, prev_week, daily_breakdown } = req.body;

    const prevWkRev     = prev_week?.total_revenue || 0;
    const prevWkMgn     = prev_week?.margin_pct    || 0;
    const revenueChange = prevWkRev > 0 ? Math.round((total_revenue - prevWkRev) / prevWkRev * 100) : null;
    const marginChange  = prevWkMgn > 0 ? (margin_pct - prevWkMgn).toFixed(1) : null;

    const prompt = `你是咖啡廳顧問，根據以下週報，用繁體中文輸出剛好兩行，不要任何標題或符號：
第一行：本週一句話總結——不只重述數字，要說明趨勢意義（例如：哪類品項帶動了成長，或哪個因素導致下滑）
第二行：一個具體可執行的行動建議——指出是哪個品項或哪天的表現值得注意，並說明店主應該採取什麼具體動作（不要只說「需注意」）

週期：${week_start} ～ ${week_end}
週營業額：$${total_revenue}${revenueChange !== null ? '（vs上週' + (revenueChange >= 0 ? '+' : '') + revenueChange + '%）' : ''}，毛利率：${margin_pct}%${marginChange !== null ? '（vs上週' + (parseFloat(marginChange) >= 0 ? '+' : '') + marginChange + '%）' : ''}
每日：${(daily_breakdown || []).map(d => d.date.slice(5) + '=$' + d.revenue).join(' ')}
毛利前五：${(top5_profit || []).map(i => i.name + '$' + i.profit).join('、')}
營收前五：${(top5_revenue || []).map(i => i.name + '$' + Math.round(i.revenue)).join('、')}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 350, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    if (!response.ok || !data.content) throw new Error(JSON.stringify(data));
    const lines = data.content[0].text.trim().split('\n').filter(l => l.trim());
    res.json({ success: true, summary: lines[0] || '', warning: lines[1] || '' });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── 原物料管理 ───────────────────────────────────────────────────────
app.get('/api/ingredients', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ingredients').select('*').order('id');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/ingredients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { unit_cost } = req.body;

    const { error } = await supabase
      .from('ingredients')
      .update({ unit_cost })
      .eq('id', id);
    if (error) throw error;

    res.json({ success: true, unit_cost });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── 品項成本主檔 ──────────────────────────────────────────────────────
app.get('/api/products-master', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('name, sell_price, cost_formula, unit_cost, category')
      .order('category').order('name');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/recalculate-costs', async (req, res) => {
  try {
    // 取所有原物料 unit_cost
    const { data: ings, error: ingsErr } = await supabase
      .from('ingredients').select('id, unit_cost');
    if (ingsErr) throw ingsErr;

    const ingMap = {};
    ings.forEach(i => { ingMap[i.id] = parseFloat(i.unit_cost) || 0; });

    // 取所有有 cost_formula 的品項
    const { data: products, error: prodErr } = await supabase
      .from('products').select('name, cost_formula').not('cost_formula', 'is', null);
    if (prodErr) throw prodErr;

    let updated = 0;
    for (const p of products) {
      try {
        // cost_formula 格式：純文字 'A1+B1+F2+F3'
        const ids       = p.cost_formula.split('+').map(s => s.trim()).filter(Boolean);
        const unit_cost = Math.round(
          ids.reduce((sum, id) => sum + (ingMap[id] || 0), 0)
          * 100) / 100;
        await supabase.from('products')
          .update({ unit_cost })
          .eq('name', p.name);
        updated++;
      } catch (_) { /* formula 格式錯誤跳過 */ }
    }

    res.json({ success: true, updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── 選物採購研究 ─────────────────────────────────────────────────────
const CURATION_SYSTEM_PROMPT = `你是山秧咖啡 / 山秧墨黛 Seyatoday 的專業選物採購研究員。

品牌核心精神：Say Today（向今天告別）、慢生活、咖啡、閱讀、書寫、氣味、自然、留白、安靜、時間感、日常儀式。
品牌哲學：山秧不製造感受，它提供讓感受自然發生的停頓。它是出發之前的地方，不留人，送人出去。視覺語言來自城市邊緣的清晨——霧、山、朝露、柔和但清醒的光線。色彩是白、鵝黃、墨綠。
品牌風格：極簡、非網紅、非潮流、非可愛系、非動漫IP、非快時尚、重視質感與耐用性。
目標客群：25-45歲都市生活族群。

採購原則（商品必須符合至少三項）：
- 能延長一杯咖啡的時間
- 能創造生活儀式感
- 不依賴流行趨勢
- 可長期販售三年以上
- 設計風格簡潔克制

評分標準：
- 品牌契合度（0-10）：與山秧世界觀的符合程度
- 商業可行性（0-10）：批發/經銷/寄賣/B2B合作可能性
- 市場熱度（0-10）：IG互動率、社群活躍度、搜尋趨勢、品牌成長跡象
- 總分 = 契合度×50% + 商業可行性×30% + 熱度×20%

seya_voice 欄位說明：
不是採購語言。用山秧說話的方式——安靜、不推銷、像對一個信任你的人說一件他還不知道的事。
不要說「這個品牌很適合山秧」。
要說「把這個放在咖啡旁邊，時間會慢下來」這種生活場景的語言。
2-3句，不超過。

必須以純JSON格式回傳，不要有任何前言或說明文字：
{"brands":[{"name":"品牌名稱","country":"國家","category":"類別（香氛/咖啡用品/閱讀書寫/居家生活）","ig":"IG帳號或N/A","website":"官網網址或N/A","scores":{"fit":數字,"commercial":數字,"heat":數字,"total":數字},"why_seya":"為什麼適合山秧（採購視角，2-3句）","target_customer":"可能吸引哪種客人（1-2句）","display":"店內展示或網站販售（一句）","procurement":"建議進貨還是寄賣及原因（一句）","contact":"是/否及原因（一句）","seya_voice":"用山秧的語言介紹這個品牌（2-3句）"}]}`;

app.post('/api/curation', async (req, res) => {
  try {
    const { userMessage } = req.body;
    if (!userMessage) return res.status(400).json({ success: false, error: '請提供 userMessage' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        system: CURATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    res.json({ success: true, content: data.content });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

const PORT = process.env.NODE_ENV !== 'production' ? (process.env.PORT || 3000) : (process.env.PORT || 3000);
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Seya Manager 伺服器啟動於 port ${PORT}`);
  });
}

module.exports = app;
