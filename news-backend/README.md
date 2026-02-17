# News Backend - API Server

This is the Express.js backend API for the Gathered News Aggregator. It handles authentication, AI content generation, and database operations.

## Setup

```bash
npm install
npm run dev
```

Server will run on `http://localhost:3000` (or PORT environment variable)

## Environment Variables

Create a `.env` file in the root:

```env
PORT=3000
NODE_ENV=development

# Supabase
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_KEY=your_supabase_service_key

# Google Generative AI
API_KEY=your_gemini_api_key
```

## API Endpoints

### Public Endpoints
- `GET /api/news` - Get all news (with optional category filter)
- `GET /api/news?category=Technology` - Get news by category

### Admin Endpoints  
- `POST /api/news` - Create news article (requires auth)
- `POST /api/aggregate` - AI auto-aggregate endpoint (requires auth)

## Deployment

Deploy to Render.com:

1. Push code to GitHub
2. Create new Web Service on Render
3. Connect your GitHub repo
4. Set environment variables in Render dashboard
5. Deploy!

### Render Configuration
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`

## Database Setup

Run `schema.sql` in your Supabase SQL editor to set up the database structure.
