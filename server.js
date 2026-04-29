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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Seya Manager 運作中' });
});

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
    const sales = results.sales_ranking;

    const merged = {
      sale_date: summary?.sale_date || payment?.sale_date || sales?.sale_date,
      items: sales?.items || [],
      gross_revenue: summary?.gross_revenue || 0,
      discount_amount: summary?.discount_amount || 0,
      total_revenue: summary?.total_revenue || payment?.total_revenue || 0,
      cash_amount: summary?.cash_amount || payment?.cash_amount || 0,
      card_amount: summary?.card_amount || payment?.card_amount || 0,
      other_amount: payment?.other_amount || 0,
      periods: summary?.periods || [],
      parse_errors: Object.keys(errors).length > 0 ? errors : null
    };

    res.json({ success: true, data: merged });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/save-daily', async (req, res) => {
  try {
    const { sale_date, items, total_revenue, gross_revenue, discount_amount, cash_amount, card_amount, other_amount } = req.body;

    const { error: cashError } = await supabase
      .from('daily_cash')
      .upsert({
        sale_date,
        total_revenue,
        cash_amount,
        card_amount,
        other_amount
      });

    if (cashError) throw cashError;

    if (items && items.length > 0) {
      const salesData = items.map(item => ({
        sale_date,
        product_name: item.product_name,
        qty_sold: item.qty_sold
      }));

      const { error: salesError } = await supabase
        .from('daily_sales')
        .insert(salesData);

      if (salesError) throw salesError;
    }

    res.json({ success: true, message: '資料已儲存' });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});


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

    const total_cost = sales.reduce((sum, s) => sum + (s.cost || 0), 0);
    const total_gross_profit = sales.reduce((sum, s) => sum + (s.gross_profit || 0), 0);
    const total_revenue = cash?.total_revenue || 0;
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
        cash_amount: cash?.cash_amount || 0,
        card_amount: cash?.card_amount || 0,
        items: sales
      }
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Seya Manager 伺服器啟動於 port ${PORT}`);
  });
}

module.exports = app;
