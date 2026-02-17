-- Create Categories Enum (Idempotent)
DO $$ BEGIN
    CREATE TYPE public.category_type AS ENUM ('India', 'Gujarat', 'World', 'Sports', 'Technology', 'Education', 'Environment', 'Business');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create News Table
CREATE TABLE IF NOT EXISTS public.news (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT[] NOT NULL,
    content TEXT NOT NULL,
    category category_type NOT NULL,
    tags TEXT[],
    image_url TEXT,
    video_url TEXT,
    source TEXT,
    author TEXT DEFAULT 'Admin',
    published_at TIMESTAMPTZ DEFAULT NOW(),
    is_breaking BOOLEAN DEFAULT FALSE,
    is_featured BOOLEAN DEFAULT FALSE,
    is_ai_generated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.news ENABLE ROW LEVEL SECURITY;

-- Policy: Everyone can read news
DO $$ BEGIN
    DROP POLICY IF EXISTS "Allow public read access" ON public.news;
    CREATE POLICY "Allow public read access" ON public.news FOR SELECT USING (true);
EXCEPTION
    WHEN undefined_table THEN null;
END $$;

-- RSS Feeds Table
CREATE TABLE IF NOT EXISTS public.rss_feeds (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    category category_type NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for rss_feeds
ALTER TABLE public.rss_feeds ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    DROP POLICY IF EXISTS "Allow public read access" ON public.rss_feeds;
    CREATE POLICY "Allow public read access" ON public.rss_feeds FOR SELECT USING (true);
EXCEPTION
    WHEN undefined_table THEN null;
END $$;

-- Subscribers Table
CREATE TABLE IF NOT EXISTS public.subscribers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT,
    email TEXT NOT NULL UNIQUE,
    whatsapp TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS for subscribers
ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    DROP POLICY IF EXISTS "Allow public insert" ON public.subscribers;
    CREATE POLICY "Allow public insert" ON public.subscribers FOR INSERT WITH CHECK (true);
EXCEPTION
    WHEN undefined_table THEN null;
END $$;

