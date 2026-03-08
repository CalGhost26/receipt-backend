// server.js
// ===== fetch polyfill (MUST be at very top, before any 'fetch' identifier is declared) =====
try {
  // if globalThis.fetch is missing or not a function, polyfill from undici
  if (typeof globalThis.fetch === 'undefined' || typeof globalThis.fetch !== 'function') {
    const undici = require('undici');
    if (undici && typeof undici.fetch === 'function') {
      globalThis.fetch = undici.fetch;
    } else {
      throw new Error('undici.fetch not available');
    }
  }
} catch (err) {
  // If the polyfill fails, log the error so Render shows it in logs.
  console.error('fetch polyfill (undici) error:', err);
}
// (optional) quick confirmation in logs:
// console.log('fetch available:', typeof globalThis.fetch === 'function' ? 'yes' : 'no');
// ==========================================================================================


require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const AWS = require('aws-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// init S3 (AWS SDK v2)
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// init Supabase (server-side service key)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// multer to store file to tmp
const upload = multer({ dest: '/tmp' });

// health
app.get('/_health', (req, res) => res.json({ ok: true }));

// DEBUG upload endpoint - temporary. Paste over your current /receipts/upload handler.
app.post('/receipts/upload', upload.single('receipt_image'), async (req, res) => {
  try {
    console.log('=== UPLOAD DEBUG START ===');
    console.log('headers:', req.headers ? Object.keys(req.headers) : '<no headers>');
    console.log('body keys:', req.body ? Object.keys(req.body) : '<no body>');
    console.log('req.file present?', Boolean(req.file));
    if (req.file) {
      console.log('req.file keys:', Object.keys(req.file));
      console.log('req.file.originalname:', req.file.originalname);
      console.log('req.file.mimetype:', req.file.mimetype);
      console.log('req.file.path:', req.file.path || '<no path>');
      console.log('req.file.size:', req.file.size || '<no size>');
    }
    console.log('req.files present?', Boolean(req.files));
    if (Array.isArray(req.files)) {
      console.log('req.files length:', req.files.length);
      req.files.forEach((f, i) => {
        console.log(`files[${i}] keys:`, Object.keys(f));
        console.log(`files[${i}].originalname:`, f.originalname);
      });
    }
    console.log('req.body:', req.body);

    return res.status(200).json({
      debug: true,
      received_body: req.body || null,
      received_file_present: !!req.file || !!req.files,
      req_file: req.file ? {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        path: req.file.path || null,
        size: req.file.size || null
      } : null,
      req_files_count: Array.isArray(req.files) ? req.files.length : null
    });
  } catch (err) {
    console.error('upload debug error:', err);
    return res.status(500).json({ error: 'internal_debug_error', message: String(err) });
  }
});

// Endpoint for Make -> Backend to POST parsed receipts
// Make must attach X-Api-Key header equal to MAKE_TO_BACKEND_API_KEY env var.
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

    // Build receipt row
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

    // Insert receipt
    const { data: receiptRow, error: receiptErr } = await supabase
      .from('receipts')
      .insert(receipt)
      .select()
      .single();

    if (receiptErr) {
      console.error('Supabase insert error:', receiptErr);
      return res.status(500).json({ error: 'db_error' });
    }

    // Prepare items and insert
    const itemsToInsert = payload.items.map(it => ({
      receipt_id: receiptRow.id,
      name: it.name,
      qty: it.qty ?? 1,
      unit: it.unit || null,
      price: it.price ?? null,
      normalized_name: it.normalized_name || null
    }));

    const { error: itemsErr } = await supabase
      .from('receipt_items')
      .insert(itemsToInsert);

    if (itemsErr) {
      console.error('Supabase insert items error:', itemsErr);
      // return 200 but indicate partial — choose behavior you prefer
      return res.status(200).json({ status: 'partial', message: 'items_insert_failed' });
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('parsed handler error:', err);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server listening on', PORT));