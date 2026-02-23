require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { OpenAI } = require('openai');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3001;

// Parse JSON bodies for the lead endpoint
app.use(express.json());

// Multer: memory storage, 50MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Use JPG, PNG, GIF, WebP, MP4, or PDF.'));
    }
  },
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

// LiteLLM client (OpenAI-compatible)
const client = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_BASE_URL,
});

app.post('/api/analyze', upload.single('file'), async (req, res) => {
  try {
    // Validate input
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    const framework = req.body.framework;
    if (!framework || !['micar', 'mifid'].includes(framework)) {
      return res.status(400).json({ success: false, error: 'Invalid framework. Use "micar" or "mifid".' });
    }

    if (!process.env.LITELLM_API_KEY || process.env.LITELLM_API_KEY === 'your-litellm-api-key') {
      return res.status(500).json({ success: false, error: 'LiteLLM API key not configured. Set LITELLM_API_KEY in .env file.' });
    }

    // Load prompt for the selected framework
    const prompt = require(`./prompts/${framework}.js`);

    // Prepare base64 image for OpenAI vision format
    const base64Data = req.file.buffer.toString('base64');
    const dataUri = `data:${req.file.mimetype};base64,${base64Data}`;

    // Call LiteLLM (OpenAI-compatible API)
    const model = process.env.LITELLM_MODEL || 'gemini/gemini-2.0-flash';

    const response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'compliance_analysis',
          schema: prompt.responseSchema,
          strict: false,
        },
      },
      messages: [
        {
          role: 'system',
          content: prompt.systemInstruction,
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt.userMessage },
            {
              type: 'image_url',
              image_url: { url: dataUri },
            },
          ],
        },
      ],
    });

    const text = response.choices[0].message.content;

    // Parse the JSON response
    let findings;
    try {
      findings = JSON.parse(text);
    } catch (parseErr) {
      console.error('Failed to parse LLM response:', text);
      return res.status(500).json({ success: false, error: 'Failed to parse AI response. Please try again.' });
    }

    // Validate structure
    if (!findings.violations) findings.violations = [];
    if (!findings.warnings) findings.warnings = [];
    if (!findings.passed) findings.passed = [];

    // Pre-classification gate: reject non-financial promotions early
    if (findings.is_financial_promotion === false) {
      return res.json({
        success: true,
        findings,
        framework,
        not_financial_promotion: true,
        rejection_reason: findings.rejection_reason || 'This image does not appear to be a financial promotion.',
      });
    }

    // Clamp coordinates to 0-100
    [...findings.violations, ...findings.warnings].forEach(f => {
      if (f.location) {
        f.location.x = Math.max(0, Math.min(100, f.location.x));
        f.location.y = Math.max(0, Math.min(100, f.location.y));
      }
    });

    return res.json({ success: true, findings, framework });

  } catch (err) {
    console.error('Analysis error:', err);

    if (err.message?.includes('quota') || err.status === 429) {
      return res.status(429).json({ success: false, error: 'API rate limit reached. Please wait a moment and try again.' });
    }

    return res.status(500).json({
      success: false,
      error: err.message || 'An unexpected error occurred during analysis.',
    });
  }
});

// SMTP email transporter
const smtpConfigured = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS;
let transporter = null;
if (smtpConfigured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// Lead capture endpoint
app.post('/api/lead', async (req, res) => {
  try {
    const { name, email, company } = req.body;

    if (!name || !email || !company) {
      return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    const lead = {
      name,
      email,
      company,
      timestamp: new Date().toISOString(),
    };

    // 1. Always store locally as backup
    const leadsFile = path.join(__dirname, 'leads.json');
    let leads = [];
    try {
      if (fs.existsSync(leadsFile)) {
        leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
      }
    } catch (e) { /* start fresh */ }
    leads.push(lead);
    fs.writeFileSync(leadsFile, JSON.stringify(leads, null, 2));

    // 2. Send email notification if SMTP is configured
    if (transporter) {
      await transporter.sendMail({
        from: `"Compliance Audit" <${process.env.SMTP_USER}>`,
        to: process.env.NOTIFY_EMAIL || process.env.SMTP_USER,
        subject: `New Lead: ${name} from ${company}`,
        html: `
          <h2>New Compliance Audit Lead</h2>
          <table style="border-collapse:collapse;font-family:sans-serif;">
            <tr><td style="padding:8px 16px;font-weight:bold;color:#002B5B;">Name</td><td style="padding:8px 16px;">${name}</td></tr>
            <tr><td style="padding:8px 16px;font-weight:bold;color:#002B5B;">Email</td><td style="padding:8px 16px;"><a href="mailto:${email}">${email}</a></td></tr>
            <tr><td style="padding:8px 16px;font-weight:bold;color:#002B5B;">Company</td><td style="padding:8px 16px;">${company}</td></tr>
            <tr><td style="padding:8px 16px;font-weight:bold;color:#002B5B;">Time</td><td style="padding:8px 16px;">${lead.timestamp}</td></tr>
          </table>
        `,
      });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Lead capture error:', err);
    return res.status(500).json({ success: false, error: 'Failed to save lead. Please try again.' });
  }
});

// Error handling for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'File too large. Maximum size is 50MB.' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Compliance Audit server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
