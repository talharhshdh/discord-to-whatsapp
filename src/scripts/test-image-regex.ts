import * as fs from 'fs';

function testRegex() {
    const html = fs.readFileSync('debug-google.html', 'utf8');
    
    // Let's search all script tags and look for image structures:
    // [0,"ID",["tbnUrl",h,w],["originalUrl",h,w],...
    const regex = /\[0\s*,\s*"([^"]+)"\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]\s*,\s*\[\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\]/g;
    
    let match;
    const items: any[] = [];
    const seenUrls = new Set<string>();
    while ((match = regex.exec(html)) !== null) {
        const id = match[1];
        const tbnUrl = match[2].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
        const imgUrl = match[5].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
        
        if (seenUrls.has(imgUrl)) continue;
        seenUrls.add(imgUrl);

        // Let's search forward from match.index to find the metadata block:
        // "2003":[null,"ID","sourceUrl","title"
        const nextChunk = html.substring(match.index, match.index + 2000);
        
        // Let's match the 2003 list
        const metaRegex = /"2003"\s*:\s*\[\s*null\s*,\s*"[^"]*"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"/;
        const metaMatch = metaRegex.exec(nextChunk);
        
        let sourceUrl = '';
        let title = '';
        if (metaMatch) {
            sourceUrl = metaMatch[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
            title = metaMatch[2];
        }

        items.push({
            id,
            tbnUrl,
            imgUrl,
            sourceUrl,
            title
        });
    }

    console.log(`Found ${items.length} unique image blocks:`);
    items.slice(0, 15).forEach((item, idx) => {
        console.log(`\nMatch ${idx + 1}:`);
        console.log(`Title:    ${item.title}`);
        console.log(`Source:   ${item.sourceUrl}`);
        console.log(`HighRes:  ${item.imgUrl}`);
        console.log(`Tbn:      ${item.tbnUrl}`);
    });
}

testRegex();
