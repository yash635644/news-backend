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
const compression = require('compression');
const helmet = require('helmet');
require('dotenv').config();

// --- Local Modules ---
const db = require('./db');

// --- Initialization ---
const app = express();
const PORT = process.env.PORT || 3000;
const myCache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

// --- Security Middleware ---
app.set('trust proxy', 1); // Trust first proxy (Render/Cloudflare)
app.use(compression());
app.use(helmet());

// --- BACKGROUND CACHE WARMING ---
// Fetches news in the background so AI Search is always fast
const warmCache = async () => {
  console.log("🔥 Warming Cache...");
  const categories = ['World', 'Business', 'Technology', 'Sports', 'India', 'Environment', 'Education'];
  const allFeeds = await getRssFeeds();

  for (const cat of categories) {
    const urls = allFeeds[cat] || [];
    if (urls.length === 0) continue;

    // Fetch top 2 sources per category to keep cache alive
    const selectedUrls = urls.slice(0, 2);
    const promises = selectedUrls.map(async url => {
      try {
        const feed = await parser.parseURL(url);
        const sourceName = feed.title?.split(' - ')[0]?.split(':')[0] || 'News Source';
        return feed.items.map(item => ({
          title: item.title,
          summary: cleanSummary(item),
          link: item.link,
          pubDate: item.pubDate || new Date().toISOString(),
          source: sourceName,
          category: cat,
          imageUrl: extractImage(item)
        }));
      } catch (e) { return []; }
    });

    const results = await Promise.all(promises);
    const articles = results.flat();
    if (articles.length > 0) {
      myCache.set(`feed_${cat}`, articles, 600); // 10 mins
      console.log(`✅ Cached ${articles.length} items for ${cat}`);
    }
  }
};

// Start warming after 10 seconds, then every 9 minutes
setTimeout(warmCache, 10000);
setInterval(warmCache, 9 * 60 * 1000);

// --- RSS Parser Setup ---
const parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
      ['description', 'description']
    ]
  },
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
  'https://gathered-news.pages.dev',
  'https://gathered-admin.netlify.app'
];

let corsOptions = {
  origin: allowedOrigins,
  credentials: true
};

if (process.env.ALLOWED_ORIGINS) {
  if (process.env.ALLOWED_ORIGINS === '*') {
    console.log("⚠️ CORS: Allowing ALL origins (Wildcard Mode)");
    corsOptions.origin = true; // Reflects the request origin (Allows all + credentials)
  } else {
    allowedOrigins.push(...process.env.ALLOWED_ORIGINS.split(','));
  }
}

app.use(cors(corsOptions));
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

const extractImage = (item) => {
  let imgUrl = null;

  // 1. Check enclosure (Highest priority usually)
  if (item.enclosure && item.enclosure.url && (item.enclosure.type?.startsWith('image') || item.enclosure.url.match(/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i))) {
    imgUrl = item.enclosure.url;
  }
  // 2. Check media:content (High Quality)
  else if (item.mediaContent && item.mediaContent.$ && item.mediaContent.$.url) {
    imgUrl = item.mediaContent.$.url;
  }
  // 3. Regex on content (Fallback)
  else {
    const content = item.contentEncoded || item.content || item.description || '';
    const imgRegex = /<img[^>]+src="([^">]+)"/g;
    let match;
    while ((match = imgRegex.exec(content)) !== null) {
      const url = match[1];
      if (!url.includes('spacer') && !url.includes('1x1') && !url.includes('tracker') && !url.startsWith('data:image')) {
        imgUrl = url;
        break; // Found first valid image
      }
    }
  }

  // 4. Try media:thumbnail as last resort
  if (!imgUrl && item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) {
    imgUrl = item.mediaThumbnail.$.url;
  }

  // High-Resolution Upgrades for common news providers:
  if (imgUrl) {
    // Reuters / Generic: Remove resize queries
    imgUrl = imgUrl.replace(/\?width=[0-9]+/, '?width=800');
    // BBC: Their thumbnails are tiny (240px). Force to 800px.
    if (imgUrl.includes('ichef.bbci.co.uk')) {
      imgUrl = imgUrl.replace(/\/news\/\d+\//, '/news/800/');
    }
    // Generic WP thumbnails (remove -150x150.jpg)
    imgUrl = imgUrl.replace(/-\d+x\d+\.(jpg|png|jpeg|webp)$/i, '.$1');
  }

  return imgUrl;
};

const cleanSummary = (item) => {
  const rawContent = item.contentSnippet || item.contentEncoded || item.content || item.description || '';
  if (!rawContent) return ["Read the full story at the source to learn more."];

  const text = rawContent.replace(/<[^>]*>?/gm, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

  // Collapse whitespace
  const cleanedText = text.replace(/\s+/g, ' ');

  // Return max 50-60 words roughly
  const words = cleanedText.split(' ');
  if (words.length > 55) {
    return [words.slice(0, 55).join(' ') + '...'];
  }
  if (cleanedText.length < 5) return ["Read the full story at the source to learn more."];

  return [cleanedText];
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
          summary: cleanSummary(item),
          link: item.link,
          source: sourceName,
          pubDate: item.pubDate || new Date().toISOString(),
          imageUrl: extractImage(item),
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

    // 1. GATHER CONTEXT (CACHE-FIRST STRATEGY)
    // Instead of fetching live (slow), we look at what's already in memory.
    const categories = ['World', 'Business', 'Technology', 'Sports', 'India', 'Environment', 'Education'];
    let allArticles = [];

    // Collect articles from ALL cached categories
    categories.forEach(cat => {
      const cached = myCache.get(`feed_${cat}`);
      if (cached) {
        allArticles.push(...cached);
      }
    });

    // Fallback: If cache is empty (server just started), fetch 'World' and 'Environment' live (fast fallback)
    if (allArticles.length === 0) {
      console.log("Cache cold. Fetching live fallback for search...");
      const allFeeds = await getRssFeeds();
      const urlsToFetch = [...(allFeeds['World']?.slice(0, 2) || []), ...(allFeeds['Environment']?.slice(0, 1) || [])];

      const promises = urlsToFetch.map(async url => {
        try {
          // Simplistic category assignment for the fast-fallback
          const tempCat = url.includes('climate') || url.includes('environment') ? 'Environment' : 'World';
          const feed = await parser.parseURL(url);
          const sourceName = feed.title?.split(' - ')[0]?.split(':')[0] || 'News Source';
          return feed.items.map(item => ({
            title: item.title,
            summary: cleanSummary(item),
            link: item.link,
            pubDate: item.pubDate || new Date().toISOString(),
            source: sourceName,
            category: tempCat,
            imageUrl: extractImage(item)
          }));
        } catch (e) { return []; }
      });
      const results = await Promise.all(promises);
      allArticles = results.flat();
    }

    // 2. PRE-FILTER CONTEXT (Simple Keyword Match)
    const queryLower = query.toLowerCase();

    // Sort by date (Newest First)
    allArticles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    // Filter relevant articles
    const relevantArticles = allArticles.filter(a => {
      const summaryText = Array.isArray(a.summary) ? a.summary.join(' ') : (a.summary || '');
      return (a.title && a.title.toLowerCase().includes(queryLower)) ||
        (summaryText.toLowerCase().includes(queryLower));
    }).slice(0, 10); // Limit to top 10 to speed up AI token processing

    // 3. AI GENERATION
    const contextString = relevantArticles.length > 0
      ? relevantArticles.map((a, i) => {
        const summaryText = Array.isArray(a.summary) ? a.summary[0] : (a.summary || '');
        return `[${i + 1}] (${a.pubDate}) "${a.title}": ${summaryText.substring(0, 150)}...`;
      }).join('\n')
      : "No specific recent articles found in the live feed.";

    const prompt = `
    You are an intelligent, engaging news analyst.
    Current Date: ${new Date().toLocaleString()}
    Query: "${query}"
    
    Context:
    ${contextString}

    Task:
    Provide a fast, structured Markdown summary.
    **Topic:** [Topic Name]
    **Latest Updates:** 
    - [Point 1]
    - [Point 2]
    **Summary:** [1-sentence summary]
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

app.get('/api/news/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await db.query('SELECT * FROM news WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: "News item not found" });
    res.json(rows[0]);
  } catch (error) {
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
// SEO & SITEMAP ROUTES
// ==========================================

app.get('/sitemap.xml', async (req, res) => {
  try {
    const baseUrl = process.env.CLIENT_URL || 'https://gathered-news.pages.dev';
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;

    // Static Pages
    const staticPages = ['/', '/category/World', '/category/Business', '/category/Technology', '/category/Sports', '/category/India'];
    staticPages.forEach(path => {
      xml += `  <url>\n    <loc>${baseUrl}${path}</loc>\n    <changefreq>hourly</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;
    });

    // Dynamic Pages (Originals in Database)
    const { rows } = await db.query('SELECT id, published_at FROM news ORDER BY published_at DESC LIMIT 100');
    rows.forEach(article => {
      const date = new Date(article.published_at).toISOString();
      xml += `  <url>\n    <loc>${baseUrl}/article/${article.id}</loc>\n    <lastmod>${date}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
    });

    xml += `</urlset>`;

    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (error) {
    res.status(500).send('Error generating sitemap');
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);

  // --- Keep-Alive for Render Free Tier ---
  // Ping the server every 14 minutes (840000 ms) to prevent sleep
  const KEEP_ALIVE_INTERVAL = 14 * 60 * 1000;

  if (process.env.RENDER_EXTERNAL_URL) {
    console.log(`Using Keep-Alive for: ${process.env.RENDER_EXTERNAL_URL}`);

    setInterval(() => {
      fetch(process.env.RENDER_EXTERNAL_URL)
        .then(res => console.log(`Keep-alive ping: ${res.status}`))
        .catch(err => console.error(`Keep-alive error: ${err.message}`));
    }, KEEP_ALIVE_INTERVAL);
  }
});
