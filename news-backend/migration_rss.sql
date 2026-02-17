-- Insert Initial RSS Feeds (Idempotent)
INSERT INTO public.rss_feeds (name, url, category)
VALUES
    ('BBC World', 'http://feeds.bbci.co.uk/news/world/rss.xml', 'World'),
    ('NYT World', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'World'),
    ('Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 'World'),
    ('Times of India', 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', 'India'),
    ('NDTV Top Stories', 'https://feeds.feedburner.com/ndtvnews-top-stories', 'India'),
    ('TechCrunch', 'https://techcrunch.com/feed/', 'Technology'),
    ('The Verge', 'https://www.theverge.com/rss/index.xml', 'Technology'),
    ('ESPN', 'https://www.espn.com/espn/rss/news', 'Sports'),
    ('Cricinfo', 'https://www.espncricinfo.com/rss/content/story/feeds/0.xml', 'Sports'),
    ('BBC Cricket', 'https://feeds.bbci.co.uk/sport/cricket/rss.xml', 'Sports'),
    ('Economist', 'https://www.economist.com/finance-and-economics/rss.xml', 'Business'),
    ('Mongabay', 'https://mongabay.com/feed/', 'Environment')
ON CONFLICT (url) DO NOTHING;

