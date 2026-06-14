const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config({ path: './.env' });

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function main() {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: 'logs/bridge-27489972447-bridge.log',
  });

  try {
    const response = await client.send(command);
    const bodyStr = await response.Body.transformToString();
    console.log('--- LOG CONTENT ---');
    console.log(bodyStr);
    console.log('--- END LOG CONTENT ---');
  } catch (err) {
    console.error('Error downloading log:', err);
  }
}

main();
