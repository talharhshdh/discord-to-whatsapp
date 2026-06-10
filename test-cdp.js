fetch("http://localhost:18080/api/go/containers/compose/parse", {
  "headers": {
    "content-type": "application/json",
    "sec-ch-ua": "\"Microsoft Edge\";v=\"149\", \"Chromium\";v=\"149\", \"Not)A;Brand\";v=\"24\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\""
  },
  "referrer": "",
  "body": "{\"yaml\":\"version: \\\"3.8\\\"\\nservices:\\n  web:\\n    image: nginx:alpine\\n    ports:\\n      - \\\"80:80\\\"\\n    environment:\\n      - PORT=80\\n      - APP_ENV=production\\n    volumes:\\n      - web_data:/usr/share/nginx/html\\n  db:\\n    image: postgres:15-alpine\\n    environment:\\n      POSTGRES_DB: main_db\\n      POSTGRES_USER: postgres\\n    volumes:\\n      - db_data:/var/lib/postgresql/data\\nvolumes:\\n  web_data:\\n  db_data:\"}",
  "method": "POST"
}).then((response) => {
  return response.text();
}).then((data) => {
  console.log(data);
}).catch((error) => {
  console.error('Error:', error);
});