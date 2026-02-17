-- Create Subscribers Table
CREATE TABLE public.subscribers (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.subscribers ENABLE ROW LEVEL SECURITY;

-- Policies
-- Public can insert (subscribe)
CREATE POLICY "Allow public insert" ON public.subscribers FOR INSERT WITH CHECK (true);
-- Only authenticated (admins) can view
CREATE POLICY "Allow auth select" ON public.subscribers FOR SELECT USING (auth.role() = 'authenticated');
-- Only authenticated (admins) can delete
CREATE POLICY "Allow auth delete" ON public.subscribers FOR DELETE USING (auth.role() = 'authenticated');
