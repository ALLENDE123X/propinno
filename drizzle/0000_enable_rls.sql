-- Custom SQL migration file, put your code below! --
-- Enable RLS
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meetings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;

-- Create policies
CREATE POLICY "Users can manage their own row" ON "users" FOR ALL USING (auth.uid() = id);
CREATE POLICY "Users can manage their own meetings" ON "meetings" FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own drafts" ON "email_drafts" FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own documents" ON "documents" FOR ALL USING (auth.uid() = user_id);