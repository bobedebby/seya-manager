if (process.env.NODE_ENV !== 'production') { require('dotenv').config(); }
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

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

async function analyzeImageWithClaude(imagePath, mimeType, imageType) {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');

  const prompts = {
    sales_ranking: `這是一張產品銷售排行表。請整理成 JSON，只回傳 JSON 不要其他文字：
{
  "sale_date": "YYYY-MM-DD",
  "items": [
    { "product_name": "品項名稱", "qty_sold": 數量, "revenue": 金額 }
  ]
}`,
    payment_detail: `這是一張結帳明細，包含現金與信用卡收款。請整理成 JSON，只回傳 JSON 不要其他文字：
{
  "sale_date": "YYYY-MM-DD",
  "total_revenue": 總金額,
  "cash_amount": 現金金額,
  "card_amount": 信用卡金額,
  "other_amount": 其他金額
}`,
    period_summary: `這是一張時段營業額總表。請整理成 JSON，只回傳 JSON 不要其他文字：
{
  "sale_date": "YYYY-MM-DD",
  "periods": [
    { "time": "時段", "amount": 金額 }
  ],
  "total_revenue": 總金額
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
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

app.post('/api/analyze-multi', upload.array('images', 3), async (req, res) => {
  try {
    const files = req.files;
    const types = req.body.types;
    const typeArray = Array.isArray(types) ? types : [types];

    const results = {};

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const imageType = typeArray[i];
      const parsed = await analyzeImageWithClaude(file.path, file.mimetype, imageType);
      results[imageType] = parsed;
      fs.unlinkSync(file.path);
    }

    const merged = {
      sale_date: results.sales_ranking?.sale_date ||
                 results.payment_detail?.sale_date ||
                 results.period_summary?.sale_date,
      items: results.sales_ranking?.items || [],
      total_revenue: results.payment_detail?.total_revenue ||
                     results.period_summary?.total_revenue || 0,
      cash_amount: results.payment_detail?.cash_amount || 0,
      card_amount: results.payment_detail?.card_amount || 0,
      other_amount: results.payment_detail?.other_amount || 0,
      periods: results.period_summary?.periods || []
    };

    res.json({ success: true, data: merged });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/save-daily', async (req, res) => {
  try {
    const { sale_date, items, total_revenue, cash_amount, card_amount, other_amount } = req.body;

    const { error: cashError } = await supabase
      .from('daily_cash')
      .upsert({ sale_date, total_revenue, cash_amount, card_amount, other_amount });

    if (cashError) throw cashError;

    if (items && items.length > 0) {
      const salesData = items.map(item => ({
        sale_date,
        product_name: item.product_name,
        qty_sold: item.qty_sold,
        revenue: item.revenue
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

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Seya Manager 伺服器啟動於 port ${PORT}`);
  });
}

module.exports = app;
