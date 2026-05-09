fetch("https://services.ufone-claim.site/api/llm/chat/stream", {
  "headers": {
    "accept": "*/*",
    "accept-language": "en-GB,en;q=0.9,en-US;q=0.8",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "pragma": "no-cache",
    "priority": "u=1, i",
    "sec-ch-ua": "\"Microsoft Edge\";v=\"147\", \"Not.A/Brand\";v=\"8\", \"Chromium\";v=\"147\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "cookie": "ph_phc_yJW1VjHGGwmCbbrtczfqqNxgBDbhlhOWcdzcIJEOTFE_posthog=%7B%22%24device_id%22%3A%22019d8aa8-4178-763c-8766-5a33222b2cee%22%2C%22distinct_id%22%3A%22019d8aa8-4178-763c-8766-5a33222b2cee%22%2C%22%24sesid%22%3A%5B1776323359174%2C%22019d9512-7294-71a8-bb9d-be99b19ca3e0%22%2C1776322507393%5D%2C%22%24initial_person_info%22%3A%7B%22r%22%3A%22%24direct%22%2C%22u%22%3A%22https%3A%2F%2Flinkwell.ufone-claim.site%2F%22%7D%2C%22%24user_state%22%3A%22anonymous%22%7D",
    "Referer": "https://services.ufone-claim.site/"
  },
  "body": "{\"messages\":[{\"role\":\"system\",\"content\":\"You are a helpful AI assistant.\"},{\"role\":\"user\",\"content\":\"what's up buddy\"},{\"role\":\"assistant\",\"content\":\"\"},{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":512,\"temperature\":0.7}",
  "method": "POST"
}).then(res=>res.json()).then(console.log)