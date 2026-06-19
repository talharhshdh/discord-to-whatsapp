import { detectAndDownload } from '../libs/downloader';
import * as fs from 'fs';

async function test() {
    console.log("🧪 Testing detectAndDownload for Instagram...");
    try {
        const url = "https://www.instagram.com/reel/DZiU2SANZf8/";
        const result = await detectAndDownload(url, async (status: string) => {
            console.log(`[Progress] ${status}`);
        });

        if (!result) {
            console.log("⚠️ No download result (unsupported platform or not found)");
            return;
        }

        console.log("✅ Result structure:", {
            mediaType: result.mediaType,
            mimetype: result.mimetype,
            caption: result.caption,
            filename: result.filename,
            bufferLength: result.buffer.length
        });

        const outputPath = "test_download.mp4";
        fs.writeFileSync(outputPath, result.buffer);
        console.log(`🎉 Downloaded video saved successfully to ${outputPath}`);
    } catch (error) {
        console.error("❌ Test failed:", error);
    }
}

test();
