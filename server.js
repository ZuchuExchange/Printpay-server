require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

const PRINTPAY_API_URL = process.env.PRINTPAY_API_URL || 'https://printpay.co.ke/api/stk_push';
const PRINTPAY_API_KEY = process.env.PRINTPAY_API_KEY;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper: Normalize Kenyan phone numbers to 2547XXXXXXXX or 2541XXXXXXXX
function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = String(phone).trim().replace(/\s+/g, '').replace(/^\+/, '');

  if (/^0[17]\d{8}$/.test(cleaned)) {
    return '254' + cleaned.slice(1);
  }
  if (/^[17]\d{8}$/.test(cleaned)) {
    return '254' + cleaned;
  }
  if (/^254[17]\d{8}$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

// Health check route
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    service: 'PrintPay STK Push Backend',
    endpoints: {
      pay: 'POST /pay',
      status: 'GET /status?checkout_id=... or POST /status'
    }
  });
});

// 1. Initiate STK Push via /pay
app.post('/pay', async (req, res) => {
  try {
    if (!PRINTPAY_API_KEY) {
      return res.status(500).json({
        success: false,
        message: 'Server configuration error: PRINTPAY_API_KEY is missing.'
      });
    }

    const rawPhone = req.body.phone_number || req.body.phone;
    const rawAmount = req.body.amount;

    const phone_number = normalizePhone(rawPhone);
    const amount = Math.round(Number(rawAmount));

    if (!phone_number) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Use format 07XXXXXXXX, 01XXXXXXXX, or 2547XXXXXXXX.'
      });
    }

    if (!amount || isNaN(amount) || amount < 1) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount. Amount must be an integer of at least 1 KES.'
      });
    }

    const payload = new URLSearchParams({
      x_api_key: PRINTPAY_API_KEY,
      phone_number,
      amount: String(amount)
    }).toString();

    const response = await axios.post(PRINTPAY_API_URL, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    });

    const data = response.data;

    if (data && (data.status === 'success' || data.checkout_id)) {
      return res.status(200).json({
        success: true,
        message: 'STK push initiated. Prompt sent to customer phone.',
        checkout_id: data.checkout_id,
        data
      });
    }

    return res.status(400).json({
      success: false,
      message: data?.message || 'Failed to initiate STK push.',
      data
    });
  } catch (error) {
    const statusCode = error.response?.status || 500;
    const providerError = error.response?.data || error.message;

    console.error('[POST /pay Error]:', providerError);

    return res.status(statusCode).json({
      success: false,
      message:
        error.response?.data?.message ||
        (error.code === 'ECONNABORTED'
          ? 'Payment gateway request timed out.'
          : 'Error communicating with PrintPay API.'),
      error: providerError
    });
  }
});

// 2. Check Transaction Status via /status (supports both GET ?checkout_id=... and POST { checkout_id })
async function handleStatusCheck(req, res) {
  try {
    const checkoutId =
      req.query.checkout_id ||
      req.query.check_status ||
      req.body?.checkout_id ||
      req.body?.check_status;

    if (!checkoutId || !String(checkoutId).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Missing checkout_id parameter.'
      });
    }

    const cleanCheckoutId = String(checkoutId).trim();

    const response = await axios.get(PRINTPAY_API_URL, {
      params: {
        check_status: cleanCheckoutId
      },
      timeout: 30000
    });

    const data = response.data;
    const txStatus = String(data?.status || '').toUpperCase();

    return res.status(200).json({
      success: txStatus === 'SUCCESS',
      status: txStatus || 'UNKNOWN',
      checkout_id: cleanCheckoutId,
      mpesa_receipt_number: data?.mpesa_receipt_number || null,
      amount: data?.amount || null,
      phone_number: data?.phone_number || null,
      data
    });
  } catch (error) {
    const statusCode = error.response?.status || 500;
    const providerError = error.response?.data || error.message;

    console.error('[Status Check Error]:', providerError);

    return res.status(statusCode).json({
      success: false,
      status: 'ERROR',
      message:
        error.response?.data?.message ||
        (error.code === 'ECONNABORTED'
          ? 'Status check request timed out.'
          : 'Failed to check transaction status.'),
      error: providerError
    });
  }
}

app.get('/status', handleStatusCheck);
app.post('/status', handleStatusCheck);

// Optional Callback receiver if you configure a webhook URL in PrintPay dashboard
app.post('/callback', (req, res) => {
  console.log('[PrintPay Callback Received]:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ received: true });
});

// 404 Handler for unknown routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found.`
  });
});

// Global Error Handler (e.g., malformed JSON in request body)
app.use((err, req, res, next) => {
  console.error('[Unhandled Server Error]:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error.'
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
