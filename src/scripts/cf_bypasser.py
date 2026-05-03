from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from seleniumbase import SB
import uvicorn
import re
import sys
import threading

app = FastAPI()

class FetchRequest(BaseModel):
    url: str

@app.post("/get_prorcp")
def get_prorcp(req: FetchRequest):
    try:
        # Using uc (Undetected Chromedriver) with headless mode.
        with SB(uc=True, headless=True) as sb:
            sb.get(req.url)
            # Wait for cloudflare page to resolve
            sb.sleep(6)
            
            source = sb.get_page_source()
            
            # 1. Regex check
            match = re.search(r'[\'"](\/?prorcp\/[^\'"]+)[\'"]', source)
            if match:
                path = match.group(1)
                full = f"https://cloudnestra.com{path}" if path.startswith('/') else path
                return {"url": full}
            
            # 2. Iframe check
            iframes = sb.find_elements("iframe")
            for iframe in iframes:
                src = iframe.get_attribute("src")
                if src and "/prorcp/" in src:
                    full = f"https://cloudnestra.com{src}" if src.startswith('/') else src
                    return {"url": full}
                    
            raise HTTPException(status_code=400, detail="Could not find /prorcp/")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/get_html")
def get_html(req: FetchRequest):
    try:
        with SB(uc=True, headless=True) as sb:
            sb.get(req.url)
            sb.sleep(6)
            source = sb.get_page_source()
            return {"html": source}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
