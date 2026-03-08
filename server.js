// server.js
// ==========
// Requirements:
// - environment variables:
//   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   MAKE_TO_BACKEND_API_KEY
//   PORT (optional)
//
// Notes:
// - This file includes:
//   * fetch polyfill (undici) for environments that lack fetch
//   * express.json middleware (so /receipts/parsed accepts JSON from Make)
//   * debug upload endpoint (/receipts/upload) using multer
//   * parsed endpoint (/receipts/parsed) which inserts into Supabase
//   * optional S3 presign endpoint (/s3/presign) for direct uploads from clients
// - Adjust any table/column names to match your Supabase schema.

try {
  if (typeof globalThis.fetch === 'undefined' || typeof globalThis.fetch !== 'function') {
    const undici = require('undici');
    if (undici && typeof undici.fetch === 'function') {
      globalThis.fetch = undici.fetch;
    } else {
      throw new Error('undici.fetch not available');
    }
  }
} catch (err) {
  console.error('fetch polyfill (undici) error:', err);
}

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const AWS = require('aws-sdk');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// Basic middleware
app.use(cors()); // allow all origins (you can lock this down in production)
app.use(express.json({ limit: '10mb' })); // parse JSON bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // parse urlencoded bodies

// Init S3 (AWS SDK v2)
const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

// Init Supabase (server-side service key)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// multer for file uploads (stores to /tmp)
const upload = multer({ dest: '/tmp' });

// health
app.get('/_health', (req, res) => res.json({ ok: true }));

// --------------------
// DEBUG upload endpoint (multipart/form-data)
// Useful for testing file uploads from Bolt or Postman.
// --------------------
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

    // Optional: move file into S3 and return URL
    let s3_url = null;
    if (req.file && process.env.S3_BUCKET) {
      const filePath = req.file.path;
      const fileContents = await fs.readFile(filePath);
      const key = `debug_uploads/${Date.now()}_${req.file.originalname}`;
      await s3.putObject({
        Bucket: process.env.S3_BUCKET,
        Key: key,
        Body: fileContents,
        ContentType: req.file.mimetype
      }).promise();
      s3_url = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
      // cleanup tmp file
      await fs.unlink(filePath).catch(()=>{});
    }

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
      req_files_count: Array.isArray(req.files) ? req.files.length : null,
      s3_url
    });
  } catch (err) {
    console.error('upload debug error:', err);
    return res.status(500).json({ error: 'internal_debug_error', message: String(err) });
  }
});

// --------------------
// Optional: generate presigned S3 upload URL for direct client uploads
// Clients (Bolt) can POST to this endpoint to get a presigned PUT URL,
// then upload directly to S3. This is recommended for larger files.
// --------------------
app.post('/s3/presign', express.json(), async (req, res) => {
  try {
    const { filename, contentType, user_id } = req.body || {};
    if (!filename || !contentType) {
      return res.status(400).json({ error: 'missing_params' });
    }
    if (!process.env.S3_BUCKET) {
      return res.status(500).json({ error: 's3_not_configured' });
    }

    const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const key = `receipts/${user_id || 'anon'}/${unique}_${path.basename(filename)}`;
    const params = {
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Expires: 60 * 10, // 10 minutes
      ContentType: contentType,
      ACL: 'private'
    };

    const url = await s3.getSignedUrlPromise('putObject', params);
    const publicUrl = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    return res.json({ uploadUrl: url, key, publicUrl });
  } catch (err) {
    console.error('presign error:', err);
    return res.status(500).json({ error: 'presign_failed', message: String(err) });
  }
});

// --------------------
// Endpoint for Make -> Backend to POST parsed receipts
// Make must attach X-Api-Key header equal to MAKE_TO_BACKEND_API_KEY env var.
// --------------------
app.post('/receipts/parsed', async (req, res) => {
  try {
    console.log('=== /receipts/parsed called ===');
    console.log('headers:', req.headers);
    // show a trimmed sample of the body for logs (avoid very large dumps)
    try {
      const bodySample = JSON.stringify(req.body);
      console.log('body sample (first 4000 chars):', bodySample.slice(0, 4000));
    } catch (e) {
      console.log('failed to stringify body for logs', e);
    }

    // API key check
    const apiKey = req.header('X-Api-Key') || req.header('Authorization');
    if (!apiKey || apiKey !== process.env.MAKE_TO_BACKEND_API_KEY) {
      console.warn('Unauthorized request to /receipts/parsed - missing or invalid API key');
      return res.status(401).json({ error: 'unauthorized' });
    }

    const payload = req.body;
    if (!payload || !payload.items || !Array.isArray(payload.items)) {
      console.warn('Bad payload (missing items array)');
      return res.status(400).json({ error: 'bad_payload', message: 'expected items array' });
    }

    // Optional idempotency: if receipt_id provided, check whether it's already present
    if (payload.receipt_id) {
      const { data: existing, error: existingErr } = await supabase
        .from('receipts')
        .select('id, receipt_id')
        .eq('receipt_id', payload.receipt_id)
        .limit(1);

      if (existingErr) {
        console.error('Supabase check existing error:', existingErr);
      } else if (existing && existing.length > 0) {
        console.log('Duplicate receipt_id detected; returning OK without re-insert. receipt_id=', payload.receipt_id);
        return res.status(200).json({ status: 'ok', info: 'duplicate_skipped' });
      }
    }

    // Build receipt object matching your DB
    const receipt = {
      receipt_id: payload.receipt_id || null,
      user_id: payload.user_id || null,
      merchant: payload.merchant || null,
      date: payload.date || null,
      subtotal: payload.subtotal ?? null,
      tax: payload.tax ?? null,
      total: payload.total ?? null,
      raw_text: payload.raw_text || null,
      image_url: payload.image_url || null,
      created_at: new Date().toISOString()
    };

    // Insert receipt row
    const { data: receiptRow, error: receiptErr } = await supabase
      .from('receipts')
      .insert(receipt)
      .select()
      .single();

    if (receiptErr) {
      console.error('Supabase insert receipt error:', receiptErr);
      return res.status(500).json({ error: 'db_error', details: receiptErr });
    }

    // Prepare items to insert
    const itemsToInsert = payload.items.map(it => ({
      receipt_id: receiptRow.id,
      name: it.name || null,
      qty: (it.qty !== undefined && it.qty !== null) ? it.qty : 1,
      unit: it.unit || null,
      price: (it.price !== undefined && it.price !== null) ? it.price : null,
      normalized_name: it.normalized_name || null
    }));

    if (itemsToInsert.length > 0) {
      const { data: itemsData, error: itemsErr } = await supabase
        .from('receipt_items')
        .insert(itemsToInsert);

      if (itemsErr) {
        console.error('Supabase insert items error:', itemsErr);
        // Decide behavior: here we return 200 with partial status so Make doesn't retry endlessly,
        // but you can change to 500 if you prefer strict failure.
        return res.status(200).json({ status: 'partial', message: 'items_insert_failed', details: itemsErr });
      }
    }

    return res.status(200).json({ status: 'ok', receipt_id: receiptRow.id });
  } catch (err) {
    console.error('parsed handler error:', err);
    return res.status(500).json({ error: 'internal_error', message: String(err) });
  }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('Server listening on', PORT));