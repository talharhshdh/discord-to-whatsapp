import { generateAndPostBlog } from '../libs/blog-generator-service';

async function main() {
  console.log('🚀 Starting Automated Blog Generation and Posting...');
  try {
    const result = await generateAndPostBlog();
    if (result.success) {
      console.log('✅ Success:', result.message);
      console.log('Published Blog Details:', JSON.stringify(result.data, null, 2));
    } else {
      console.error('❌ Failed:', result.message);
      if (result.error) console.error('Error Details:', result.error);
      process.exit(1);
    }
  } catch (err: any) {
    console.error('💥 Unexpected error during blog generation:', err.message);
    process.exit(1);
  }
}

main();
