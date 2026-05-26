import * as fs from 'fs';

function fixDuplicateTest() {
    const filePath = 'd:\\discord-whatsapp\\src\\scripts\\test-search-pool.ts';
    let content = fs.readFileSync(filePath, 'utf8');

    const startTag = '                return {\n                    captcha: false,\n                    organic: cleanOrganic,';
    const endTag = '            }, category);';

    const startIdx = content.indexOf(startTag);
    const endIdx = content.indexOf(endTag);

    if (startIdx !== -1 && endIdx !== -1) {
        const replacement = `                return {
                    captcha: false,
                    organic: cleanOrganic,
                    aiResponse: categoryParam === 'all' ? aiResponse : null,
                    featuredSnippet: categoryParam === 'all' ? featuredSnippet : null,
                    knowledgePanel: categoryParam === 'all' ? knowledgePanel : null,
                    peopleAlsoAsk: categoryParam === 'all' ? peopleAlsoAsk : undefined,
                    directAnswer: categoryParam === 'all' ? directAnswer : null,
                    news: cleanNews.length > 0 ? cleanNews : undefined,
                    videos: cleanVideos.length > 0 ? cleanVideos : undefined,
                    images: cleanImages.length > 0 ? cleanImages : undefined,
                    shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
                    relatedSearches: categoryParam === 'all' ? relatedSearches : undefined,
                    localResults: cleanLocalResults.length > 0 ? cleanLocalResults : undefined
                };
            }, categoryKey);`;

        content = content.substring(0, startIdx) + replacement + content.substring(endIdx + endTag.length);
        console.log("Cleaned test-search-pool evaluate return successfully!");
    } else {
        const norm = (str: string) => str.replace(/\r\n/g, '\n');
        let normContent = norm(content);
        const normStartTag = norm(startTag);
        const normEndTag = norm(endTag);
        
        const nStartIdx = normContent.indexOf(normStartTag);
        const nEndIdx = normContent.indexOf(normEndTag);
        
        if (nStartIdx !== -1 && nEndIdx !== -1) {
            const replacement = `                return {
                    captcha: false,
                    organic: cleanOrganic,
                    aiResponse: categoryParam === 'all' ? aiResponse : null,
                    featuredSnippet: categoryParam === 'all' ? featuredSnippet : null,
                    knowledgePanel: categoryParam === 'all' ? knowledgePanel : null,
                    peopleAlsoAsk: categoryParam === 'all' ? peopleAlsoAsk : undefined,
                    directAnswer: categoryParam === 'all' ? directAnswer : null,
                    news: cleanNews.length > 0 ? cleanNews : undefined,
                    videos: cleanVideos.length > 0 ? cleanVideos : undefined,
                    images: cleanImages.length > 0 ? cleanImages : undefined,
                    shopping: cleanShopping.length > 0 ? cleanShopping : undefined,
                    relatedSearches: categoryParam === 'all' ? relatedSearches : undefined,
                    localResults: cleanLocalResults.length > 0 ? cleanLocalResults : undefined
                };
            }, categoryKey);`;

            content = normContent.substring(0, nStartIdx) + replacement + normContent.substring(nEndIdx + normEndTag.length);
            console.log("Cleaned test-search-pool evaluate return with normalized content successfully!");
        } else {
            console.error("Could not locate test-search-pool return duplicate block.");
        }
    }

    fs.writeFileSync(filePath, content, 'utf8');
}

fixDuplicateTest();
