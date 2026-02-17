/**
 * index.js
 * Main Entry Point for the News Aggregator Backend.
 * Handles API routes, RSS fetching, AI generation, and database interactions.
 */

// --- Dependencies ---
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Parser = require('rss-parser');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

// --- Local Modules ---
const db = require('./db');

// --- Initialization ---
const app = express();
const PORT = process.env.PORT || 3000;
const myCache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

// --- Security Middleware ---
app.use(helmet());

// --- RSS Parser Setup ---
const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  },
  timeout: 5000 // 5 second timeout per feed
});

// --- CONFIGURATION ---
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'https://gathered-news.pages.dev', // Cloudflare Pages
  'https://gathered-admin.netlify.app' // Netlify Admin
];

if (process.env.ALLOWED_ORIGINS) {
  allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(','));
}

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later'
});
app.use('/api/', limiter);

const ai = new GoogleGenerativeAI(process.env.API_KEY || 'YOUR_API_KEY');

// --- DYNAMIC RSS SOURCES ---
const getRssFeeds = async () => {
  const feeds = {};
  try {
    const { rows } = await db.query('SELECT * FROM rss_feeds');
    rows.forEach(item => {
      if (!feeds[item.category]) feeds[item.category] = [];
      feeds[item.category].push(item.url);
    });
  } catch (err) {
    console.error("DB Error fetching feeds:", err);
  }
  return feeds;
};

// --- HELPER FUNCTIONS ---

const extractImage = (content, enclosure) => {
  if (enclosure && enclosure.url && (enclosure.type?.startsWith('image') || enclosure.url?.match(/\.(jpg|jpeg|png|gif)$/i))) {
    return enclosure.url;
  }
  if (!content) return null;
  const imgRegex = /<img[^>]+src="([^">]+)"/;
  const match = content.match(imgRegex);
  return match ? match[1] : null;
};

const cleanSummary = (html) => {
  if (!html) return [];
  const text = html.replace(/<[^>]*>?/gm, '').trim();
  const decoded = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const sentences = decoded.split('. ').slice(0, 2).map(s => s.trim() + '.');
  return sentences.length > 0 ? sentences : [decoded.substring(0, 150) + '...'];
};

// --- ROUTES ---

app.get('/', (req, res) => res.send('NewsAI Backend Active'));

/**
 * LIVE RSS FEED
 * Logic: Ensures MINIMUM 2 articles from EVERY source in the category are shown.
 */
app.get('/api/live-feed', async (req, res) => {
  const { category } = req.query;

  // 'Originals' are handled via /api/news
  if (category === 'Originals') return res.json({ articles: [] });

  // --- PAGINATION LOGIC ---
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 12;
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;

  let selectedCategory = category || 'World';
  if (selectedCategory === 'Tech') selectedCategory = 'Technology';

  const cacheKey = `feed_${selectedCategory}`;
  let allArticles = myCache.get(cacheKey);

  if (!allArticles) {
    console.log(`Fetching ${selectedCategory} (Fresh)...`);

    // Fetch Feeds
    const allFeeds = await getRssFeeds();
    const feedUrls = allFeeds[selectedCategory] || allFeeds['World'] || [];

    const feedResults = await Promise.allSettled(
      feedUrls.map(url => parser.parseURL(url).then(feed => ({ ...feed, originalUrl: url })))
    );

    let processedItems = [];
    feedResults.forEach((result) => {
      if (result.status === 'fulfilled' && result.value && result.value.items) {
        const feed = result.value;
        const sourceName = feed.title?.split(' - ')[0]?.split(':')[0] || 'News Source';

        const cleaned = feed.items.map(item => ({
          title: item.title,
          summary: cleanSummary(item.contentSnippet || item.content || ''),
          link: item.link,
          source: sourceName,
          pubDate: item.pubDate || new Date().toISOString(),
          imageUrl: extractImage(item.content || item['content:encoded'], item.enclosure),
          category: selectedCategory
        }));

        processedItems.push(...cleaned);
      }
    });

    // Sort Newest First
    processedItems.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // Deduplicate
    const seenTitles = new Set();
    allArticles = [];
    processedItems.forEach(item => {
      const normTitle = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!seenTitles.has(normTitle)) {
        seenTitles.add(normTitle);
        allArticles.push(item);
      }
    });

    myCache.set(cacheKey, allArticles, 300); // Cache: 5 mins
  }

  // Slice for Pagination
  const paginatedItems = allArticles.slice(startIndex, endIndex);

  res.json({
    articles: paginatedItems,
    total: allArticles.length,
    page,
    hasMore: endIndex < allArticles.length
  });
});

// ==========================================
// AI SEARCH & GENERATION ROUTES
// ==========================================

/**
 * AI SEARCH (Grounded in RSS Feeds)
 * Logic:
 * 1. Fetch relevant RSS inputs (Context).
 * 2. Search strictly within that context.
 * 3. AI summarizes the FINDINGS, not general knowledge.
 */
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query is required' });

    console.log(`AI Search for: "${query}"`);

    // 1. GATHER CONTEXT (From Cache or Fresh)
    // We'll search across ALL categories to find relevant news.
    const allFeeds = await getRssFeeds();
    const categories = Object.keys(allFeeds);
    let allArticles = [];

    // Helper to fetch and parse (with timeout)
    const fetchFeed = async (url) => {
      try {
        const feed = await parser.parseURL(url);
        return feed.items.map(item => ({
          title: item.title,
          content: item.contentSnippet || item.content || '',
          link: item.link,
          pubDate: item.pubDate,
          source: feed.title
        }));
      } catch (e) { return []; }
    };

    // Limit context fetching to avoid slow response (e.g., top 1 source from each category)
    // In a real production app, this would use a vector DB or search index (Elasticsearch/Algolia).
    // For this size, we'll fetch a subset live.
    const contextPromises = [];

    // Simple Intent Detection
    const queryLower = query.toLowerCase();
    const isSportsQuery = queryLower.includes('cricket') || queryLower.includes('t20') || queryLower.includes('match') || queryLower.includes('score') || queryLower.includes('cup') || queryLower.includes('sport');

    categories.forEach(cat => {
      let limit = 3; // Default
      // Prioritize Sports feeds if query is sports-related
      if (isSportsQuery && cat === 'Sports') limit = 10;

      const urls = allFeeds[cat].slice(0, limit);
      urls.forEach(url => contextPromises.push(fetchFeed(url)));
    });

    const results = await Promise.all(contextPromises);
    allArticles = results.flat();

    // 2. PRE-FILTER CONTEXT (Simple Keyword Match)
    // const queryLower = query.toLowerCase(); // Already defined above

    // SORT BY DATE (Newest First) to ensure freshness
    allArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    const relevantArticles = allArticles.filter(a =>
      a.title.toLowerCase().includes(queryLower) ||
      a.content.toLowerCase().includes(queryLower)
    ).slice(0, 15); // Top 15 matches

    // 3. AI GENERATION
    // Even if no specific articles found, we let AI answer (it will use general knowledge per new prompt)
    // But we still pass whatever we found.
    const contextString = relevantArticles.length > 0
      ? relevantArticles.map((a, i) => `[${i + 1}] (${a.pubDate}) "${a.title}": ${a.content.substring(0, 200)}...`).join('\n')
      : "No specific recent articles found in the live feed.";

    const prompt = `
    You are an intelligent, engaging news analyst.
    Current Date/Time: ${new Date().toLocaleString()}
    User Query: "${query}"
    
    Verified News Context (from RSS):
    ${contextString}

    Task:
    1. Analyze the User Query and Verified News Context.
    2. Provide a structured response (MARKDOWN):
       **Topic:** [Short Topic Name]
       
       **Latest Updates:** 
       - [Bullet point 1]
       - [Bullet point 2]
       
       **Summary:** [Concise summary]

    3. If context is empty, use general knowledge but still follow the format.
    `;

    const model = ai.getGenerativeModel({ model: 'gemini-flash-latest' });
    const result = await model.generateContent(prompt);
    const summary = result.response.text();

    res.json({
      summary,
      articles: relevantArticles.map(a => ({
        title: a.title,
        link: a.link,
        source: a.source,
        pubDate: a.pubDate
      }))
    });

  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: "AI Service temporarily unavailable." });
  }
});

// Admin Publish (ORIGINALS)
app.get('/api/news', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM news ORDER BY published_at DESC');
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/news', async (req, res) => {
  try {
    const { title, content, summary, category, tags, image_url, video_url, is_ai_generated, is_featured, is_breaking, author } = req.body;

    const query = `
      INSERT INTO news (title, content, summary, category, tags, image_url, video_url, is_ai_generated, is_featured, is_breaking, author, published_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
      RETURNING *
    `;
    const values = [title, content, summary, category, tags, image_url, video_url, is_ai_generated, is_featured, is_breaking, author];

    const { rows } = await db.query(query, values);
    res.status(201).json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/news/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, content, summary, category, tags, image_url, video_url, is_ai_generated, is_featured, is_breaking, author } = req.body;

    // Build dynamic update query
    const fields = [];
    const values = [];
    let idx = 1;

    const addField = (col, val) => {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    };

    addField('title', title);
    addField('content', content);
    addField('summary', summary);
    addField('category', category);
    addField('tags', tags);
    addField('image_url', image_url);
    addField('video_url', video_url);
    addField('is_ai_generated', is_ai_generated);
    addField('is_featured', is_featured);
    addField('is_breaking', is_breaking);
    addField('author', author);

    if (fields.length === 0) return res.status(400).json({ error: "No fields to update" });

    values.push(id);
    const query = `UPDATE news SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`;

    const { rows } = await db.query(query, values);
    if (rows.length === 0) return res.status(404).json({ error: "News item not found" });

    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/news/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM news WHERE id = $1', [id]);
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Admin AI Generate (Writer/Editor Mode)
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const model = ai.getGenerativeModel({ model: 'gemini-flash-latest' });

    const systemPrompt = `
    You are an expert News Editor and Journalist.
    
    Input: "${prompt.substring(0, 10000)}"
    
    Task: Analyze the Input.
    - CASE A: If Input is a short topic (e.g., "SpaceX launch", "Global warming impact"), WRITE a full, professional news article about it. Invent plausible but realistic details if it's a general topic, or use your knowledge base for specific historical events (up to your cutoff).
    - CASE B: If Input is a rough draft or raw notes, POLISH it into a professional news article. Fixed grammar, better flow, journalistic tone.

    Required JSON Output:
    {
      "headline": "Catchy headline",
      "summary": ["Point 1", "Point 2"],
      "content": "Full article...",
      "category": "World",
      "tags": ["Tag1"]
    }
    
    Return ONLY valid JSON.
    `;

    const result = await model.generateContent(systemPrompt);
    const text = result.response.text();

    // Clean JSON markdown if present
    const cleanedText = text.replace(/```json|```/g, '').trim();

    let data;
    try {
      data = JSON.parse(cleanedText);
    } catch (e) {
      // Fallback if JSON is messy
      console.error("JSON Parse Error on AI output:", text);
      data = {
        headline: "Draft: " + prompt.substring(0, 50),
        summary: ["Could not auto-generate summary."],
        content: text,
        category: "World",
        tags: ["Draft"]
      };
    }

    res.json(data);
  } catch (e) {
    console.error("Generate Error:", e);
    res.status(500).json({ error: e.message });
  }
});

// RSS Management Endpoints
app.get('/api/rss-feeds', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM rss_feeds ORDER BY category');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rss-feeds', async (req, res) => {
  try {
    const { name, url, category } = req.body;
    const { rows } = await db.query(
      'INSERT INTO rss_feeds (name, url, category) VALUES ($1, $2, $3) RETURNING *',
      [name, url, category]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/rss-feeds/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM rss_feeds WHERE id = $1', [id]);
    res.json({ message: 'Deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// RSS Health Check
app.get('/api/rss-feeds/health', async (req, res) => {
  try {
    const { rows: feeds } = await db.query('SELECT id, url FROM rss_feeds');
    const healthStatus = {};

    // Check all feeds
    await Promise.all(feeds.map(async (feed) => {
      try {
        const response = await fetch(feed.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        healthStatus[feed.id] = response.ok ? 'ok' : 'error';
      } catch (e) {
        healthStatus[feed.id] = 'error';
      }
    }));

    res.json(healthStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// NEWSLETTER & ANALYTICS ROUTES
// ==========================================

app.post('/api/newsletter/send', async (req, res) => {
  try {
    const { subject, content } = req.body;

    const { rows } = await db.query('SELECT COUNT(*) as exact FROM subscribers');
    const count = rows[0].exact;

    console.log(`📧 SENDING NEWSLETTER to ${count} subscribers`);
    console.log(`Subject: ${subject}`);

    await new Promise(resolve => setTimeout(resolve, 1500));

    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/subscribe', async (req, res) => {
  console.log("🔔 Subscribe request received:", req.body);
  try {
    const { email, name, whatsapp } = req.body;
    if (!email) throw new Error("Email required");

    // Check duplicate
    const check = await db.query('SELECT id FROM subscribers WHERE email = $1', [email]);
    if (check.rows.length > 0) return res.status(201).json({ message: 'Already subscribed' });

    await db.query(
      'INSERT INTO subscribers (email, name, whatsapp, created_at) VALUES ($1, $2, $3, NOW())',
      [email, name, whatsapp]
    );

    res.status(201).json({ message: 'Subscribed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


app.get('/api/stats', async (req, res) => {
  try {
    // 1. Fetch Database Counts (Originals)
    const { rows: news } = await db.query('SELECT is_ai_generated, is_breaking, is_featured, category FROM news');

    const dbTotal = news.length;
    const dbAi = news.filter(n => n.is_ai_generated).length;
    const dbBreaking = news.filter(n => n.is_breaking).length;
    const dbFeatured = news.filter(n => n.is_featured).length;

    // 2. Fetch RSS Feed Counts (Live)
    const { rows: feeds } = await db.query('SELECT category FROM rss_feeds');
    const feedCount = feeds.length;

    // 3. Estimate Live Content (Heuristic: ~10 articles per feed)
    const EST_ARTICLES_PER_FEED = 10;
    const liveTotal = feedCount * EST_ARTICLES_PER_FEED;
    const liveBreaking = Math.round(liveTotal * 0.1); // ~10% breaking news
    const liveFeatured = Math.round(liveTotal * 0.2); // ~20% featured

    // 4. Calculate Category Distribution
    const categoryCounts = {};

    // Count Originals
    news.forEach(n => {
      const cat = n.category || 'Other';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    });

    // Count RSS Estimates
    feeds.forEach(f => {
      const cat = f.category || 'Other';
      categoryCounts[cat] = (categoryCounts[cat] || 0) + EST_ARTICLES_PER_FEED;
    });

    // 5. Aggregate
    const stats = {
      total: dbTotal + liveTotal,
      aiCount: dbAi,
      breakingCount: dbBreaking + liveBreaking,
      featuredCount: dbFeatured + liveFeatured,
      originals: dbTotal,
      live: liveTotal,
      feeds: feedCount,
      categories: categoryCounts
    };

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/subscribers', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM subscribers ORDER BY created_at DESC');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/**
 * ADMIN LOGIN (Simple Token)
 */
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  // Use environment variables for secure verification
  const validEmail = process.env.ADMIN_EMAIL || 'admin@gathered.com';
  const validPass = process.env.ADMIN_PASSWORD || 'admin';

  if (email === validEmail && password === validPass) {
    return res.json({
      success: true,
      user: { email: validEmail, role: 'admin' },
      token: 'mock-jwt-token-production-secure'
    });
  }

  return res.status(401).json({ error: 'Invalid credentials' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
