from fastapi import FastAPI, HTTPException, File, UploadFile, Response
from pydantic import BaseModel
from seleniumbase import SB
import uvicorn
import re
import sys
import threading
import io
from rembg import remove

app = FastAPI()

class FetchRequest(BaseModel):
    url: str

@app.post("/get_prorcp")
def get_prorcp(req: FetchRequest):
    try:
        # Using uc (Undetected Chromedriver) with headless=False so it appears on VNC display
        with SB(uc=True, headless=False) as sb:
            sb.uc_open_with_reconnect(req.url, 5)
            
            try:
                sb.uc_gui_click_captcha()
            except Exception:
                pass

            # Loop up to 30 times (120 seconds) to give user time to click Cloudflare captcha via VNC
            for i in range(30):
                sb.sleep(4)
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
                        
            sb.save_screenshot("cf_screenshot.png")
            raise HTTPException(status_code=400, detail="Could not find /prorcp/")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/get_html")
def get_html(req: FetchRequest):
    try:
        with SB(uc=True, headless=False) as sb:
            sb.uc_open_with_reconnect(req.url, 5)
            try:
                sb.uc_gui_click_captcha()
            except Exception:
                pass
            sb.sleep(6)
            source = sb.get_page_source()
            return {"html": source}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/remove_bg")
async def remove_bg(file: UploadFile = File(...)):
    try:
        input_image = await file.read()
        output_image = remove(input_image)
        return Response(content=output_image, media_type="image/png")
    except Exception as e:
        print(f"Error removing background: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
