-- Add name and whatsapp columns to subscribers table
ALTER TABLE public.subscribers 
ADD COLUMN IF NOT EXISTS name TEXT,
ADD COLUMN IF NOT EXISTS whatsapp TEXT;
