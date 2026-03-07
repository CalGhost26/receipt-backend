// === fetch polyfill using undici (MUST be the very first lines) ===
try {
  if (typeof globalThis.fetch === 'undefined') {
    // require() works in CommonJS; undici exports a fetch implementation
    const { fetch } = require('undici');
    globalThis.fetch = fetch;
  }
} catch (err) {
  // If the polyfill fails for any reason, log it immediately so Render shows it
  // and the deploy won't silently swallow the error.
  // This helps diagnose install/runtime problems.
  // Do NOT remove this console.error while debugging.
  console.error('fetch polyfill (undici) error:', err);
}
// ================================================================


require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fetch = require('node-fetch');
const AWS = require('aws-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// init S3
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// init Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// multer to store file to tmp
const upload = multer({ dest: '/tmp' });

app.post('/receipts/upload', upload.single('receipt_image'), async (req, res) => {
  try {
    const userId = req.body.user_id || null;
    if (!req.file) return res.status(400).json({ error: 'no_file' });

    // Upload to S3
    const fileStream = fs.createReadStream(req.file.path);
    const key = `receipts/${Date.now()}_${req.file.originalname.replace(/\s+/g,'_')}`;
    const uploadRes = await s3.upload({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: fileStream,
      ContentType: req.file.mimetype,
      ACL: 'private'
    }).promise();

    // Presigned GET URL (so Make can fetch the file)
    const presignedUrl = s3.getSignedUrl('getObject', {
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Expires: 3600 // seconds
    });

    const makePayload = { user_id: userId, image_url: presignedUrl, source: 'bolt-app-backend' };

    const makeResp = await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(makePayload),
    });

    // cleanup local temp file
    fs.unlink(req.file.path, () => {});

    if (!makeResp.ok) {
      console.error('Make webhook error', await makeResp.text());
      return res.status(502).json({ error: 'forwarding_failed' });
    }

    return res.status(202).json({ status: 'processing', image_url: uploadRes.Location });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

app.post('/receipts/parsed', async (req, res) => {
  try {
    const apiKey = req.header('X-Api-Key') || req.header('Authorization');
    if (!apiKey || apiKey !== process.env.MAKE_TO_BACKEND_API_KEY) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const payload = req.body;
    if (!payload || !payload.items || !Array.isArray(payload.items)) {
      return res.status(400).json({ error: 'bad_payload' });
    }

    const receipt = {
      receipt_id: payload.receipt_id || null,
      user_id: payload.user_id || null,
      merchant: payload.merchant || null,
      date: payload.date || null,
      subtotal: payload.subtotal || null,
      tax: payload.tax || null,
      total: payload.total || null,
      raw_text: payload.raw_text || null,
      image_url: payload.image_url || null,
      created_at: new Date().toISOString()
    };

    const { data: receiptRow, error: receiptErr } = await supabase
      .from('receipts')
      .insert(receipt)
      .select()
      .single();

    if (receiptErr) {
      console.error('Supabase insert error:', receiptErr);
      return res.status(500).json({ error: 'db_error' });
    }

    const itemsToInsert = payload.items.map(it => ({
      receipt_id: receiptRow.id,
      name: it.name,
      qty: it.qty || 1,
      unit: it.unit || null,
      price: it.price || null,
      normalized_name: it.normalized_name || null
    }));

    const { error: itemsErr } = await supabase
      .from('receipt_items')
      .insert(itemsToInsert);

    if (itemsErr) {
      console.error('Supabase insert items error:', itemsErr);
      return res.status(200).json({ status: 'partial', message: 'items_insert_failed' });
    }

    // optionally notify the client here (websockets / supabase realtime)
    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server listening on', PORT));