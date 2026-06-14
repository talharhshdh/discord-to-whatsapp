import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';

dotenv.config();

const {
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_ACCOUNT_ID
} = process.env;

async function run() {
  if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET_NAME || !R2_ACCOUNT_ID) {
    console.error('❌ Missing R2 configuration in environment variables.');
    process.exit(1);
  }

  console.log('🧹 Deleting state.tar.gz from Cloudflare R2 bucket...');

  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  const deleteCommand = new DeleteObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: 'state.tar.gz',
  });

  try {
    await s3Client.send(deleteCommand);
    console.log('✅ Successfully deleted state.tar.gz from Cloudflare R2.');
  } catch (err: any) {
    console.error('❌ Failed to delete state.tar.gz from Cloudflare R2:', err.message || err);
  }
}

run();
