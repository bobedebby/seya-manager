if (process.env.NODE_ENV !== 'production') { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; }
if (process.env.NODE_ENV !== 'production') { require('dotenv').config(); }
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
  "coupon_amount": 折價券金額數字（沒有則為0）,
  "discount_amount": 折讓金額數字（沒有則為0）,
  "total_revenue": 營業金額減去折價券金額再減去折讓金額的結果,
  "cash_amount": 付現金額數字,
  "card_amount": 刷卡金額數字,
  "periods": [
    { "time": "時段數字", "amount": 營業額數字, "customers": 客數數字 }
  ]
}`
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64Image }
          },
          { type: 'text', text: prompts[imageType] }
        ]
      }]
    })
  });

  const data = await response.json();
  const text = data.content[0].text.trim();
  console.log('Claude回傳[' + imageType + ']:', text.substring(0, 300));
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── 圖片解析 ────────────────────────────────────────────────────────
app.post('/api/analyze-multi', upload.array('images', 3), async (req, res) => {
  try {
    const files = req.files;
    const types = req.body.types;
    const typeArray = Array.isArray(types) ? types : [types];

    const results = {};
    const errors = {};

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const imageType = typeArray[i];
      try {
        const parsed = await analyzeImageWithClaude(file.buffer, file.mimetype, imageType);
        results[imageType] = parsed;
      } catch (e) {
        errors[imageType] = e.message;
      }
    }

    const summary = results.period_summary;
    const payment = results.payment_detail;
    const sales   = results.sales_ranking;

    const merged = {
      sale_date:       summary?.sale_date || payment?.sale_date || sales?.sale_date,
      items:           sales?.items || [],
      gross_revenue:   summary?.gross_revenue || 0,
      discount_amount: summary?.discount_amount || 0,
      total_revenue:   summary?.total_revenue || payment?.total_revenue || 0,
      cash_amount:     summary?.cash_amount  || payment?.cash_amount  || 0,
      card_amount:     summary?.card_amount  || payment?.card_amount  || 0,
      other_amount:    payment?.other_amount || 0,
      periods:         summary?.periods || [],
      parse_errors:    Object.keys(errors).length > 0 ? errors : null
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
      gross_revenue, discount_amount,
      cash_amount, card_amount, other_amount
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
      .insert({ sale_date, total_revenue, cash_amount, card_amount, other_amount });

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
        .select('product_name, qty_sold, gross_profit')
        .eq('sale_date', sale_date);

      for (const row of (savedRows || [])) {
        // 已有正確毛利則跳過
        if (row.gross_profit != null && row.gross_profit > 0) continue;

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

    const total_cost         = sales.reduce((sum, s) => sum + (s.cost         || 0), 0);
    const total_gross_profit = sales.reduce((sum, s) => sum + (s.gross_profit || 0), 0);
    const total_revenue      = cash?.total_revenue || 0;
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
    const { data, error } = await supabase
      .from('daily_sales')
      .select('sale_date')
      .order('sale_date', { ascending: true });

    if (error) throw error;

    // 去重，只保留唯一日期
    const dates = [...new Set(data.map(r => r.sale_date))];
    res.json({ success: true, dates });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
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

const PORT = process.env.NODE_ENV !== 'production' ? (process.env.PORT || 3000) : (process.env.PORT || 3000);
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Seya Manager 伺服器啟動於 port ${PORT}`);
  });
}

module.exports = app;
