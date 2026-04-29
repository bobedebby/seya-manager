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
  '單品黑咖啡':   'Today單品',
  '重拿鐵':       '重拿鐵咖啡',
  '單品豆1/4磅':  '配方豆1/4磅',
  '柚香灑酒拿鐵': '柚香灑酒拿鐵',  // 強制對應，防止字元比對失敗
  '果乾磅蛋糕':   '山午磅蛋糕',
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

    // 1. 存 daily_cash
    const { error: cashError } = await supabase
      .from('daily_cash')
      .upsert(
        { sale_date, total_revenue, cash_amount, card_amount, other_amount },
        { onConflict: 'sale_date' }
      );

    if (cashError) throw cashError;

    // 2. 存 daily_sales（先清掉同日舊資料避免重複）
    if (items && items.length > 0) {
      await supabase.from('daily_sales').delete().eq('sale_date', sale_date);

      const salesData = items.map(item => ({
        sale_date,
        product_name: item.product_name,
        qty_sold:     item.qty_sold
      }));

      const { error: salesError } = await supabase
        .from('daily_sales')
        .insert(salesData);

      if (salesError) throw salesError;

      // 3. 用 SQL UPDATE JOIN 在資料庫層直接回填成本，完全繞過 Node 字串比對問題
      const { error: fillError } = await supabase.rpc('backfill_daily_sales_cost', {
        p_sale_date: sale_date
      });
      if (fillError) console.warn('成本回填 RPC 失敗:', fillError.message);

      // 4. 處理 PRODUCT_NAME_MAP 別名（POS 名稱與 products 不同的品項）
      const aliasItems = items.filter(item => {
        const { resolvedName } = resolveProductName(item.product_name);
        return resolvedName !== item.product_name;
      });

      for (const item of aliasItems) {
        const { resolvedName } = resolveProductName(item.product_name);
        const { data: p } = await supabase
          .from('products')
          .select('sell_price, cost_price')
          .eq('name', resolvedName)
          .single();
        if (!p) continue;
        const unit_price  = parseFloat(p.sell_price);
        const cost        = parseFloat(p.cost_price) * item.qty_sold;
        const gross_profit = unit_price * item.qty_sold - cost;
        await supabase
          .from('daily_sales')
          .update({ unit_price, cost, gross_profit })
          .eq('sale_date', sale_date)
          .eq('product_name', item.product_name);
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

const PORT = process.env.NODE_ENV !== 'production' ? (process.env.PORT || 3000) : (process.env.PORT || 3000);
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Seya Manager 伺服器啟動於 port ${PORT}`);
  });
}

module.exports = app;
