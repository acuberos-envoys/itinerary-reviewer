/**
 * Itinerary Reviewer — Express Server
 *
 * Setup:
 *   1. npm install
 *   2. Set environment variable: ANTHROPIC_API_KEY=sk-ant-...
 *   3. npm start  →  http://localhost:3000
 *
 * Deploy (free options):
 *   - Render.com: connect GitHub repo, set ANTHROPIC_API_KEY in Environment
 *   - Railway.app: same process
 *   - Any Node 18+ host works
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Proxy: fetch a Google Sheet as CSV ───────────────────────────────────────
app.get('/api/fetch-sheet', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  try {
    // Extract sheet ID and gid
    const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return res.status(400).json({ error: 'Could not parse Google Sheets URL' });
    const sheetId = idMatch[1];
    const gidMatch = url.match(/[#&?]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : '0';

    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
    const response = await fetch(csvUrl, { redirect: 'follow' });

    if (!response.ok) {
      return res.status(400).json({
        error: 'Could not fetch sheet. Make sure it is shared as "Anyone with the link can view".'
      });
    }

    const csv = await response.text();
    res.type('text/plain').send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Main analysis endpoint ────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY is not set on the server. Ask your administrator to configure it.'
    });
  }

  const { itinerary } = req.body;
  if (!itinerary || itinerary.trim().length < 20) {
    return res.status(400).json({ error: 'Please provide itinerary content.' });
  }

  const systemPrompt = `You are an expert travel planner and itinerary reviewer. Evaluate travel itineraries and return structured JSON feedback.

Return ONLY a valid JSON object — no markdown, no commentary outside the JSON — with this exact shape:

{
  "tripName": "Short name for the trip (city/country and dates if present)",
  "days": [
    {
      "day": "Day label, e.g. 'Day 1 – Rome'",
      "pace": { "score": 1-5, "note": "One concise sentence" },
      "flow": { "score": 1-5, "note": "One concise sentence" },
      "activityCount": { "count": number, "rating": "Light|Ideal|Busy|Overloaded", "note": "One concise sentence" },
      "balance": { "score": 1-5, "note": "One concise sentence" },
      "suggestions": ["Actionable suggestion", "Actionable suggestion"]
    }
  ],
  "overall": {
    "verdict": "One sentence overall assessment",
    "strengths": ["Strength 1", "Strength 2"],
    "topChanges": ["Highest-priority change", "Second change", "Third change"]
  }
}

Scoring rubrics:
- PACE (1–5): 5 = perfect timing, adequate time per activity and transit; 3 = some activities feel rushed or gaps too long; 1 = physically impossible to complete in the time shown
- FLOW (1–5): 5 = activities are geographically clustered and in logical order; 3 = some unnecessary backtracking; 1 = scattered locations requiring excessive travel
- ACTIVITY COUNT: Light = <3 main activities, Ideal = 3–5, Busy = 6–7, Overloaded = 8+
- BALANCE (1–5): 5 = great mix of culture, food, leisure, sightseeing, rest; 3 = somewhat repetitive types; 1 = monotonous or exhausting`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Review this itinerary:\n\n${itinerary}` }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || `API error ${response.status}` });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    let result;
    try {
      result = JSON.parse(text);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) result = JSON.parse(match[0]);
      else throw new Error('Response was not valid JSON. Please try again.');
    }

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✈  Itinerary Reviewer running at http://localhost:${PORT}`);
});
