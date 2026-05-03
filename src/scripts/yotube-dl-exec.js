const youtubedl = require('youtube-dl-exec')
const fs = require("fs")
youtubedl('https://youtu.be/7r_WJ9xpne0?si=UfRdObYQCKsrNYpR', {
    dumpSingleJson: true,
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
    addHeader: ['referer:youtube.com', 'user-agent:googlebot']
}).then(output => {
    fs.writeFileSync("./src/scripts/youtube-dl-response.json", JSON.stringify(output, null, 2))
})