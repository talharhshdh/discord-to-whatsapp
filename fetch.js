const fs = require('fs');

async function fetchGoogle() {
  const response = await fetch("https://www.google.com/search?q=hrami&oq=hrami&gs_lcrp=EgRlZGdlKgYIABBFGDkyBggAEEUYOdIBCDEwMDFqMGo3qAIAsAIA&sourceid=chrome&ie=UTF-8&source=chrome.ob&sg_ss=*3uKa4obyAAY_AygeHwN9w1_zNk7Q6GEEAEABEArZ1ChccfXt6S4RGE-NbRPPT-OLcemCDkwEcnBXn6IcoyflbEeLnjywhCoeyaktatJaktNDR-F4yf254EF7PQAAADVtAAAADVcBB0EANUwlONCECu3x3D3c6cvq3UWanoZxCA94AqwLS6soUWFAL3mF6uzQlhbAvi_CcvpV25Ra5Z3FpgPyxrV1_Fq1C4d6XfuaEoV2yTAVCMnj0c_oAXRiH27u3vvUxCelT1O9S0PcXhYdZ4kUUf0sTW9evUOr4jzZRlXyjNIrR5MT5-3-_i4Cz4WRerApyPVd1RfOkTlPWcWJPaL5JQT57a9yP_lZM6wAwJkY6s5kcHjtvjCk3JPfDk7OfRDNZEtsbbnRiKuSeEUHUJSoNcYTOXL5InoL8WYOQ_U45K0zqgVPnqGnAHKL7YZ5s6Xt_8c0ytnpXa121KePzAZ3JFUWFl2kTQP0uFR3u6ZBozUFkxHYNvkm0ro3diqR_pdL9xh1MlofH_3zYoqqt7P4qBlp5vbP3T2NnEkZIe7cDXUmIP0GrUOJirCzavx6zm_De5eofuLJCnfeimoarnB5X9ZNI3vtvdRvPD7yJaKXL-_6j-fJYsOkUY-mVcx7AKNztWMMa0Mm53Q8m3L2ur3KeW-bX9NCVQJK0dD2H6AnmQSTfTWROFZDVvHDJwuj895nPCLxLttq1MqmxpVzJioNTpo_AI-JAn0Q8mVglyo-UMowIlcz03KNU5AlWLHzvjKsMjg_bymnUhwsWsSHVjNorG1GSm84QNA3k2xHKouJcWDDI27KC31wZNLhVSVTALy5YL4jvW1eslv1_lH_50NxoR3CEYuEzuv0DCN4QakyIq4rY78qBrTW929A0kmNhVHC3ByX8x9pKnH7ymE4z8LNWQCk1XfSrQPOPwYO1aRQYc3W8St6d7nSN0rvwdnJziusTxEAG65TcXn02rbiJsEeAKFrOQKrS1qObj9VprUVfsqQwnnveyN2yOjqVegHHJKeFsWNEWV0dK-aIQtxe5lA_OK0UimA4OH9D_g5zohkVdGaXvPTjxTbBav0PK8Vvu2xj4KTMfGJB6LNwWWymp70kHjRO9H1otRSwNkbeSC1vwJFZImtg_H9pbeH2JC48his9GRDEyrTknfiyW97b5BuLJk_9dkZLu8pek3E7c18RWfBNawxverFEOHyv6tci0mbuixZ544oQzIL43qWRHrEBhGHEQzVRbHy3chwVvQ_FKKi5tA3ZT7seYUxAY0kWkEKUAaHRh-CuONMQk3FitNeshziTToAhL4S69ztk_tqpmM70KNi1zhmffc8vdbw85oak9DHefSihyBmbEPPfWQIdydBAltu1b05DQucu-P3RJ2N7XgcS3TKvRDyRUkpsTSKHrYHFwd4vXJC9XXq9iXoOhpjwBnyjuVQPrk_KAjHdfuFrhkolY8H01jlQxMAVPzy7vZwvDaHQ5moiPO4WDAhLSyZhcQi7EPkUR_u9mwlTyb91SyqJzV1ZMfcDYo6hdyr1CvlLVyw9u-dz8EQl8Vi6FI", {
    "headers": {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "accept-language": "en-GB,en;q=0.9",
      "cache-control": "no-cache",        
      "downlink": "1.4",
      "pragma": "no-cache",
      "preferanonymous": "1",
      "priority": "u=0, i",
      "rtt": "300",
      "sec-ch-prefers-color-scheme": "dark",
      "sec-ch-ua": "\"Chromium\";v=\"148\", \"Google Chrome\";v=\"148\", \"Not/A)Brand\";v=\"99\"",
      "sec-ch-ua-arch": "\"x86\"",
      "sec-ch-ua-bitness": "\"64\"",
      "sec-ch-ua-form-factors": "\"Desktop\"",
      "sec-ch-ua-full-version": "\"148.0.7778.180\"",
      "sec-ch-ua-full-version-list": "\"Chromium\";v=\"148.0.7778.180\", \"Google Chrome\";v=\"148.0.7778.180\", \"Not/A)Brand\";v=\"99.0.0.0\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-model": "\"\"",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-ch-ua-platform-version": "\"19.0.0\"",
      "sec-ch-ua-wow64": "?0",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "upgrade-insecure-requests": "1",
      "x-browser-channel": "stable",
      "x-browser-copyright": "Copyright 2026 Google LLC. All Rights Reserved.",
      "x-browser-validation": "+f/6R40gd6znZQYfwfSnAdnLwLk=",
      "x-browser-year": "2026",
      "cookie": "AEC=AaJma5v_eq0inCJD9G9deS0KIG0KkuW6Rr1nVjRW9x9dn-24hPuYXERizw8; NID=531=JK-byphpWfVnQ8JXKkob7o9soygTEYbFMOypg4Vs8T1zphfp2wYBHS7TSfsJPggJi6ZnybJhU1M68sbELU3uie4EbKFuQH3oJgMtmzBWITFLzDJ3FZBEYUDQMBZ340GI1isbWXRL5ru9G05_WaQDJ9Ailsk_o5CcTniqDm5HpEghtn5F8wsuVIHmrbEG0V_GLw7EeBiTaWWKPc0rL0hRV_0fvGYBNp3Jk17vZTWqwqtyk12xSBZo; __Secure-STRP=ANmZwa3wzlR5HzBLeq6Dqq5-wcCssED5zcNTIN96inGPLSKtP8oFRXHPCIrEvxkwDEyMu9iahAtNT54EX4fFWH-uw-dqzFp_l1eU",
      "Referer": "https://www.google.com/search?q=hrami&oq=hrami&gs_lcrp=EgRlZGdlKgYIABBFGDkyBggAEEUYOdIBCDEwMDFqMGo3qAIAsAIA&sourceid=chrome&ie=UTF-8&source=chrome.ob&sei=EHgVaorVHsmP-d8P5oygkA8"
    },
    "body": null,
    "method": "GET"
  });
  const html = await response.text();
  fs.writeFileSync('google.html', html);
  console.log('Saved to google.html');
}

fetchGoogle().catch(console.error);
