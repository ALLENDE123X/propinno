import { describe, it, expect } from 'vitest'
import { createClient } from '@supabase/supabase-js'

describe('Row Level Security (RLS)', () => {
  // Only run this test if a real Supabase instance is available
  it.skipIf(!process.env.NEXT_PUBLIC_SUPABASE_URL)('should prevent reading another user\'s email_draft', async () => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    
    const supabase = createClient(supabaseUrl, supabaseKey)
    
    // Attempt to read another user's email_draft using the anon client
    const { data, error } = await supabase
      .from('email_drafts')
      .select('*')
      .eq('user_id', 'some-other-user-id')
      
    // Assert 0 rows returned
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })
})
