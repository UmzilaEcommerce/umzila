exports.handler = async function(event, context) {
  console.log('=== SIMPLE TEST FUNCTION START ===');
  
  try {
    console.log('1. Testing environment variables...');
    console.log('SUPABASE_URL exists:', !!process.env.SUPABASE_URL);
    console.log('SUPABASE_SERVICE_ROLE_KEY exists:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
    
    // Try to parse the body
    console.log('2. Testing JSON parsing...');
    const body = event.body ? JSON.parse(event.body) : {};
    console.log('Body parsed successfully');
    
    // Try to require supabase
    console.log('3. Testing Supabase import...');
    const { createClient } = require('@supabase/supabase-js');
    console.log('Supabase imported successfully');
    
    // Try to create client
    console.log('4. Testing Supabase client creation...');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    console.log('Supabase client created');
    
    // Try a simple query
    console.log('5. Testing Supabase query...');
    const { data, error } = await supabase
      .from('products')
      .select('id')
      .limit(1);
    
    if (error) {
      console.error('Query error:', error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: 'Supabase query failed',
          details: error.message
        })
      };
    }
    
    console.log('6. Query successful, found:', data?.length || 0, 'products');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: 'All tests passed',
        env_vars: {
          SUPABASE_URL: process.env.SUPABASE_URL ? 'Set' : 'Missing',
          SUPABASE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Set (length: ' + process.env.SUPABASE_SERVICE_ROLE_KEY.length + ')' : 'Missing'
        },
        supabase_test: {
          connected: true,
          products_found: data?.length || 0
        }
      })
    };
    
  } catch (error) {
    console.error('Test function error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Test failed',
        message: error.message,
        stack: error.stack
      })
    };
  }
};