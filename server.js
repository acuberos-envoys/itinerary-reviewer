/**
 * Itinerary Reviewer — Express Server (v2)
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

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an expert travel planner and itinerary reviewer with access to web search.

Review the provided itinerary and return ONLY a valid JSON object — no markdown, no text outside the JSON.

Your tasks for each day:

1. FEASIBILITY CHECK: Use web search to verify whether each listed attraction or activity is open on the scheduled date. Look for:
   - Regular closing days (e.g., many museums close Mondays or Tuesdays)
   - Seasonal or temporary closures
   - Public holiday schedule changes
   - Early closing times that conflict with the planned visit
   Report specific findings for every notable attraction you can verify.

2. SCORES (all 1–10):
   - PACE: 10=perfect timing with adequate time per activity and transit; 5=some activities feel rushed; 1=physically impossible to complete
   - FLOW: 10=activities geographically clustered in logical order; 5=some unnecessary backtracking; 1=scattered locations requiring excessive travel
   - BALANCE: 10=excellent mix of culture, food, leisure, sightseeing, rest; 5=somewhat repetitive; 1=monotonous or exhausting
   - ACTIVITY COUNT: Light(<3), Ideal(3–5), Busy(6–7), Overloaded(8+)

3. GENERAL SCORE (1–10): A holistic score for the entire itinerary.

Return this exact JSON structure:
{
  "tripName": "Short trip name with destination and dates if present",
  "generalScore": 7.5,
  "days": [
    {
      "day": "Day 1 – City, Date",
      "feasibility": {
        "hasIssues": true,
        "issues": [
          {
            "activity": "Attraction name",
            "issue": "Specific issue, e.g. closed Tuesdays",
            "severity": "high|medium|low"
          }
        ]
      },
      "pace": { "score": 8, "note": "One concise sentence." },
      "flow": { "score": 7, "note": "One concise sentence." },
      "activityCount": { "count": 4, "rating": "Ideal", "note": "One concise sentence." },
      "balance": { "score": 9, "note": "One concise sentence." },
      "suggestions": ["Actionable suggestion", "Another suggestion"]
    }
  ],
  "overall": {
    "verdict": "One sentence overall assessment",
    "strengths": ["Strength 1", "Strength 2"],
    "topChanges": ["Priority change 1", "Priority change 2", "Priority change 3"]
  }
}`;

// Same prompt but instructs Claude to use training knowledge if web search unavailable
const SYSTEM_PROMPT_NO_SEARCH = SYSTEM_PROMPT.replace(
  'Use web search to verify whether each listed attraction or activity is open on the scheduled date.',
  'Use your training knowledge to flag whether each listed attraction is typically open on the scheduled day of week. Note any attractions commonly closed on that day, those with limited hours, or those that commonly require advance booking.'
);

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

  const userMessage = `Review this itinerary:\n\n${itinerary}`;

  try {
    let text = await runWithWebSearch(userMessage);
    if (!text) throw new Error('No response received. Please try again.');

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

// Tries web search first; falls back to knowledge-based if tool is unavailable
async function runWithWebSearch(userMessage) {
  const messages = [{ role: 'user', content: userMessage }];

  // ── Attempt 1: with web search tool ──────────────────────────────────────
  try {
    for (let round = 0; round < 15; round++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }],
          messages
        })
      });

      // If the tool type is unrecognized, fall through to the no-search path
      if (response.status === 400) {
        const err = await response.json().catch(() => ({}));
        if (err.error?.message?.toLowerCase().includes('tool')) break;
        throw new Error(err.error?.message || `API error ${response.status}`);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${response.status}`);
      }

      const data = await response.json();

      if (data.stop_reason === 'end_turn') {
        return data.content.filter(b => b.type === 'text').pop()?.text || '';
      }

      if (data.stop_reason === 'tool_use') {
        // Add assistant turn and provide placeholder tool results so the loop continues
        messages.push({ role: 'assistant', content: data.content });
        const toolResults = data.content
          .filter(b => b.type === 'tool_use')
          .map(b => ({
            type: 'tool_result',
            tool_use_id: b.id,
            content: 'Search complete. Continue with your analysis.'
          }));
        if (toolResults.length) messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // max_tokens or other stop reason — grab whatever text exists
      return data.content.filter(b => b.type === 'text').pop()?.text || '';
    }
  } catch (err) {
    // Re-throw real errors; fall through only for tool-related 400s
    if (!err.message.includes('tool')) throw err;
  }

  // ── Attempt 2: knowledge-based fallback (no web search tool) ─────────────
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT_NO_SEARCH,
      messages: [{ role: 'user', content: userMessage }]
    })
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  return data.content.filter(b => b.type === 'text').pop()?.text || '';
}

app.listen(PORT, () => {
  console.log(`✈  Itinerary Reviewer running at http://localhost:${PORT}`);
});
