const fs = require('fs');

async function run() {
    // Parse target reel shortcode/URL from command line arguments
    const arg = process.argv[2] || "https://www.instagram.com/reels/DZuSUiZvzZD/";
    const match = arg.match(/\/reels?\/([A-Za-z0-9_\-]+)/) || arg.match(/^([A-Za-z0-9_\-]+)$/);
    const shortcode = match ? match[1] : "DZuSUiZvzZD";

    console.log(`🎯 Targeting Reel Shortcode: ${shortcode}`);

    const headers = {
        "accept": "*/*",
        "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
        "content-type": "application/x-www-form-urlencoded",
        "priority": "u=1, i",
        "sec-ch-prefers-color-scheme": "dark",
        "sec-ch-ua": "\"Microsoft Edge\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
        "sec-ch-ua-full-version-list": "\"Microsoft Edge\";v=\"149.0.4022.69\", \"Chromium\";v=\"149.0.7827.115\", \"Not)A;Brand\";v=\"24.0.0.0\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-model": "\"\"",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-ch-ua-platform-version": "\"19.0.0\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "x-asbd-id": "359341",
        "x-bloks-version-id": "6a1a99aad521621204ad31915fc0c45ea5ef62c4d409c123a63ab00c26644d3c",
        "x-csrftoken": "RuRfo4YVVLe36Fmubi4lCPGNAjPgpNnz",
        "x-fb-friendly-name": "PolarisClipsTabDesktopPaginationQuery",
        "x-fb-lsd": "7w-X0yZTFUrItDbwsrmuuT",
        "x-ig-app-id": "936619743392459",
        "x-ig-max-touch-points": "0",
        "x-root-field-name": "xdt_api__v1__clips__home__connection_v2",
        "cookie": "datr=tQ9AaN0k1nJ5-s7vKlZS9UYS; ps_l=1; ps_n=1; mid=aXjHJAALAAHZ4omyd0ebSy9JGEB2; ds_user_id=74746116933; csrftoken=RuRfo4YVVLe36Fmubi4lCPGNAjPgpNnz; ig_did=5906265C-E189-4CD5-9F76-2B5B4FF3D41A; dpr=1.25; sessionid=74746116933%3A68S1uRjPm1RDUb%3A6%3AAYgwhey3C_lUF0OsrB7GTp-3zIjNkCW3cYJltrw6zRE; wd=1213x948; rur=\"RVA\\05474746116933\\0541813401870:01ff261438d2b5600ba440b7482549c17940ec379859b0469563a9c6bb99ef8b32c7f43b\"",
        "Referer": `https://www.instagram.com/reels/${shortcode}/`
    };

    const variables = {
        after: "GhaG2fmbk9Kk7mwm8Lzb99tnFAI0AikIGAAaCBgNczoxOWVkZjdiNmYzOBQBGgYZDBaG2fmbk9Kk7mwA",
        before: null,
        data: {
            container_module: "clips_tab_desktop_page",
            seen_reels: JSON.stringify([]),
            chaining_media_id: shortcode,
            should_refetch_chaining_media: false
        },
        first: 10,
        last: null,
        __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
        __relay_internal__pv__PolarisAIGMMediaWebLabelEnabledrelayprovider: false
    };

    const postData = {
        av: "17841474788003264",
        __d: "www",
        __user: "0",
        __a: "1",
        __req: "b",
        __hs: "20623.HYP:instagram_web_pkg.2.1...0",
        dpr: "1",
        __ccg: "GOOD",
        __rev: "1041789422",
        __s: "v3jela:aclzj4:8kbcq7",
        __hsi: "7653055630017428357",
        __dyn: "7xeUjG1mxu1syUbFp41twpUnwgU7SbzEdF8aUco2qwJw5ux609vCwjE1EE2Cw8G11wBw5Zx62G3i1ywOwv89k2C0O86a0D82IzXwae4UaEW2G0AEco5G0zEnwhE2Lw62wLyES1Twoob82ZwrUdUbGwmk0KU6O1FwlA1HQp1yU426V8aUuwm8jw4kyVrx60luawOwi84q2i0jK3mew",
        __csr: "gP136MrYIYRvincxONlgFlKKWcTmLZCKArLVWVnJm-CZ4yCP8F5TJlFCDhKKAKaV5VpoF5z98OECmJd5p9UJ29qCAOk5p8yfuQ-Qui4d2XAKCcmbWCyUoypF8W2KUtwBxB1m6VEbVe4odovAGUhDBSmu8WU9Erx9126k4EK9xO8-3KdBix5oK48mGm4U8E8EtBz806Oq0bTw1Z-00OaUuw2pE3MCwe103LU2Iwfi0qKbBolw1BK3CiE0XMi0Ho6a0zO02eEjwFgaU3vw2cA0nS5VRg62rYw-05e85px201jow0ghU668g",
        __hsdp: "gMxps46yYGOqbEy7F8khXGilXp4EykwNWntpFmSUByUZdosKWwmp3pBAx62sAwvBo7l4x2i0geExo8827wbK1Xx60RUK7F8O0xEoK12wZxGQ9w810zxq2y0hqcwwy80DS6o0BC480VO2a0cSg0jywlU11U1A-0qO2u0i-04bo1hA0Wo3XwywAzF80ByE",
        __hblp: "0Hwb-9wgVbxWq5onxO0yVu5pHz8gzoa65awFwhofE4qfzE88bo5C1fGfwywRwuUSUe8d84W6EK7F8O2q22227ooK12wZxGQ9AK1Tg8UmwEwbSUaUa8O228xK0mG14xa0DEpw5oxy0UpogwtU1ME1oo8E0Pp033o1D8dU5ufwtU7-2i0ctwDw4Lxm0C80B20iS2S0hx0bW2G2a0S88E98Wi0ui1PG",
        __sjsp: "mxZEmn2ExWbOHGjuJ8uAxh7KunXp4EykwNWntpFmSUByU-hosyE6N6x61lo",
        __comet_req: "7",
        fb_dtsg: "NAfyJ0MR6wMhUV5EOMWYEfXYPIEPOVqgdP82tpXYLCjKMRO8JExhhlQ:17865379441060568:1778309334",
        jazoest: "26163",
        lsd: "7w-X0yZTFUrItDbwsrmuuT",
        __spin_r: "1041789422",
        __spin_b: "trunk",
        __spin_t: "1781865868",
        __crn: "comet.igweb.PolarisClipsTabDesktopProfiledContentRoute",
        fb_api_caller_class: "RelayModern",
        fb_api_req_friendly_name: "PolarisClipsTabDesktopPaginationQuery",
        server_timestamps: "true",
        variables: JSON.stringify(variables),
        doc_id: "36825039943776829"
    };

    const body = new URLSearchParams(postData).toString();

    console.log("🚀 Sending request to Instagram GraphQL...");
    try {
        const res = await fetch("https://www.instagram.com/graphql/query", {
            method: "POST",
            headers,
            body
        });

        console.log(`📡 Response Status: ${res.status} ${res.statusText}`);
        const contentType = res.headers.get("content-type") || "";
        console.log(`📄 Content-Type: ${contentType}`);

        const text = await res.text();

        if (contentType.includes("application/json")) {
            try {
                const json = JSON.parse(text);
                fs.writeFileSync("response.json", JSON.stringify(json, null, 2), "utf8");
                console.log("✅ JSON response saved to response.json");

                // Extract video URL
                const edges = json.data?.xdt_api__v1__clips__home__connection_v2?.edges || [];
                const videoUrl = edges[0]?.node?.media?.video_versions?.[0]?.url;

                if (videoUrl) {
                    console.log(`📥 Found video URL, downloading to ${shortcode}.mp4...`);
                    const videoRes = await fetch(videoUrl);
                    if (videoRes.ok) {
                        const arrayBuffer = await videoRes.arrayBuffer();
                        fs.writeFileSync(`${shortcode}.mp4`, Buffer.from(arrayBuffer));
                        console.log(`✅ Video saved successfully as ${shortcode}.mp4`);
                    } else {
                        console.error(`❌ Failed to download video: ${videoRes.status} ${videoRes.statusText}`);
                    }
                } else {
                    console.log("⚠️ No video URL found in response.");
                }
            } catch (err) {
                console.error("❌ Failed to parse JSON response:", err.message);
                fs.writeFileSync("response.txt", text, "utf8");
                console.log("💾 Raw response saved to response.txt");
            }
        } else {
            fs.writeFileSync("response.html", text, "utf8");
            console.log("💾 HTML/Text response saved to response.html");
            if (text.length > 500) {
                console.log("🔍 Response preview:", text.substring(0, 500) + "...");
            } else {
                console.log("🔍 Response:", text);
            }
        }
    } catch (error) {
        console.error("❌ Request failed:", error);
    }
}

run();