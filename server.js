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

// Replace your existing /receipts/upload handler with this block
app.post('/receipts/upload', upload.single('receipt_image'), async (req, res) => {
  try {
    console.log('=== UPLOAD (full pipeline) START ===');
    console.log('received file?', Boolean(req.file), 'body:', req.body ? Object.keys(req.body) : null);

    if (!req.file) {
      return res.status(400).json({ error: 'missing_file', message: 'expecting multipart form field "receipt_image"' });
    }

    // basic file metadata
    const originalName = req.file.originalname || req.file.filename || 'receipt.jpg';
    const contentType = req.file.mimetype || 'application/octet-stream';
    const userId = req.body.user_id || null;
    const receiptIdFromClient = req.body.receipt_id || null;

    // If S3 configured -> upload
    let s3Key = null;
    let s3Url = null;
    if (process.env.S3_BUCKET) {
      const filePath = req.file.path;
      const fileContents = await fs.readFile(filePath); // read from /tmp
      // create a deterministic key for receipts
      const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      s3Key = `receipts/${userId || 'anon'}/${unique}_${path.basename(originalName)}`;

      await s3.putObject({
        Bucket: process.env.S3_BUCKET,
        Key: s3Key,
        Body: fileContents,
        ContentType: contentType,
        ACL: 'private'
      }).promise();

      // create short-lived presigned GET for OCR.space and later preview
      s3Url = await s3.getSignedUrlPromise('getObject', {
        Bucket: process.env.S3_BUCKET,
        Key: s3Key,
        Expires: 60 * 10 // 10 minutes
      });

      // cleanup local tmp file
      await fs.unlink(filePath).catch(()=>{});
    } else {
      // If no S3, we can still send OCR.space the raw file bytes via multipart (but we prefer S3)
      console.warn('S3_BUCKET not configured: skipping S3 upload. Using a local file buffer for OCR (not persisted).');
    }

    // Call OCR.space with the presigned GET URL if available; otherwise, call with raw text fallback
    const ocrApiKey = process.env.OCR_SPACE_API_KEY;
    let ocrParsedText = null;
    let ocrRawResponse = null;

    if (!ocrApiKey) {
      console.warn('No OCR_SPACE_API_KEY set - skipping OCR step.');
    } else {
      try {
        // If we have an s3Url, ask OCR.space to fetch it. This avoids needing multipart build tools.
        if (s3Url) {
          const params = new URLSearchParams();
          params.append('url', s3Url);
          params.append('language', 'eng');
          // optional: params.append('OCREngine', '2');

          const ocrResp = await fetch('https://api.ocr.space/parse/image', {
            method: 'POST',
            headers: {
              'apikey': ocrApiKey,
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: params.toString()
          });

          ocrRawResponse = await ocrResp.json().catch(()=>null);
          if (ocrRawResponse && Array.isArray(ocrRawResponse.ParsedResults) && ocrRawResponse.ParsedResults[0]) {
            ocrParsedText = ocrRawResponse.ParsedResults[0].ParsedText || null;
          }
        } else {
          // If no S3, we can fall back to sending raw file bytes to OCR.space, but that requires building multipart.
          // For simplicity we skip this path by default (you can extend later).
          console.warn('No s3Url available to send to OCR.space. Skipping OCR.');
        }
      } catch (ocrErr) {
        console.error('OCR.space call failed:', ocrErr);
      }
    }

    // Insert a simple receipt row into Supabase (raw_text + image_url)
    const receiptRow = {
      receipt_id: receiptIdFromClient || null,
      user_id: userId || null,
      merchant: null,
      date: null,
      subtotal: null,
      tax: null,
      total: null,
      raw_text: ocrParsedText || (ocrRawResponse ? JSON.stringify(ocrRawResponse).slice(0, 2000) : null),
      image_url: s3Url || null,
      created_at: new Date().toISOString()
    };

    const { data: insertedReceipt, error: insertErr } = await supabase
      .from('receipts')
      .insert(receiptRow)
      .select()
      .single();

    if (insertErr) {
      console.error('Supabase insert error:', insertErr);
      return res.status(500).json({ error: 'db_error', details: insertErr });
    }

    // Return succinct response for Make
    return res.status(200).json({
      status: 'ok',
      receipt_id: insertedReceipt.id,
      s3_key: s3Key,
      s3_url: s3Url,
      raw_text: ocrParsedText,
      ocr_raw: ocrRawResponse
    });
  } catch (err) {
    console.error('upload pipeline error:', err);
    return res.status(500).json({ error: 'internal_error', message: String(err) });
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


// GET /s3/presign-get?key=<object-key>&expires=<seconds(optional)>
app.get('/s3/presign-get', async (req, res) => {
  try {
    const key = req.query.key || req.query.Key;
    const expires = Number(req.query.expires) || 60 * 10; // default 10 minutes
    if (!key) return res.status(400).json({ error: 'missing_key' });

    // ensure bucket env var
    const bucket = process.env.S3_BUCKET;
    if (!bucket) return res.status(500).json({ error: 's3_not_configured' });

    const params = {
      Bucket: bucket,
      Key: key,
      Expires: expires
    };

    // getSignedUrlPromise is available on AWS SDK v2 in Node
    const url = await s3.getSignedUrlPromise('getObject', params);
    return res.json({ url, expires });
  } catch (err) {
    console.error('presign-get error:', err);
    return res.status(500).json({ error: 'presign_get_failed', message: String(err) });
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