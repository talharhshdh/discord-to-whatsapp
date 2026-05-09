from fastapi import FastAPI, HTTPException, File, UploadFile, Response
from pydantic import BaseModel
from seleniumbase import SB
import uvicorn
import re
import sys
import threading
import io
from rembg import remove
import whisper
import easyocr
import tempfile
import os

app = FastAPI()

# Pre-load models (will download on first run in GH Actions)
print("Loading Whisper tiny model...")
whisper_model = whisper.load_model("tiny")
print("Loading EasyOCR reader...")
reader = easyocr.Reader(['en']) # Add more languages if needed

class FetchRequest(BaseModel):
    url: str

class ScreenshotRequest(BaseModel):
    url: str
    full_page: bool = False
    format: str = "png"

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

@app.post("/ocr")
async def ocr_image(file: UploadFile = File(...)):
    try:
        content = await file.read()
        results = reader.readtext(content)
        text = " ".join([res[1] for res in results])
        return {"text": text}
    except Exception as e:
        print(f"OCR Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/transcribe")
async def transcribe_audio(file: UploadFile = File(...)):
    try:
        # Whisper requires a file on disk
        with tempfile.NamedTemporaryFile(delete=False, suffix=".ogg") as tmp:
            content = await file.read()
            tmp.write(content)
            tmp_path = tmp.name

        try:
            result = whisper_model.transcribe(tmp_path)
            return {"text": result["text"]}
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
    except Exception as e:
        print(f"Transcription Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/screenshot")
async def take_screenshot(req: ScreenshotRequest):
    try:
        with SB(uc=True, headless=False) as sb:
            sb.uc_open_with_reconnect(req.url, 5)
            try:
                sb.uc_gui_click_captcha()
            except Exception:
                pass
            sb.sleep(5) # Wait for page to load
            
            sb.execute_script("document.body.style.overflow = 'hidden';")
            
            if req.full_page:
                width = sb.execute_script("return Math.max(document.body.scrollWidth, document.body.offsetWidth, document.documentElement.clientWidth, document.documentElement.scrollWidth, document.documentElement.offsetWidth);")
                height = sb.execute_script("return Math.max(document.body.scrollHeight, document.body.offsetHeight, document.documentElement.clientHeight, document.documentElement.scrollHeight, document.documentElement.offsetHeight);")
                sb.set_window_size(width, height)
                sb.sleep(1)

            import base64
            
            if req.format.lower() == "pdf":
                pdf_data = sb.driver.execute_cdp_cmd("Page.printToPDF", {
                    "printBackground": True,
                    "marginTop": 0,
                    "marginBottom": 0,
                    "marginLeft": 0,
                    "marginRight": 0,
                })
                content = base64.b64decode(pdf_data['data'])
                return Response(content=content, media_type="application/pdf")
            else:
                with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as tmp:
                    sb.save_screenshot(tmp.name)
                    tmp_path = tmp.name

                try:
                    with open(tmp_path, "rb") as f:
                        content = f.read()
                    return Response(content=content, media_type="image/png")
                finally:
                    if os.path.exists(tmp_path):
                        os.remove(tmp_path)
    except Exception as e:
        print(f"Screenshot Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class SearchRequest(BaseModel):
    text: str
    pageNumber: int = 1

@app.post("/search")
def google_search(req: SearchRequest):
    try:
        with SB(uc=True, headless=False) as sb:
            start = (req.pageNumber - 1) * 10
            sb.uc_open_with_reconnect(
                f"https://www.google.com/search?q={req.text}&start={start}", 5
            )
            try:
                sb.uc_gui_click_captcha()
            except Exception:
                pass
            sb.sleep(3)

            # Parse organic results
            organic = []
            results = sb.find_elements("#search .g")
            for el in results:
                try:
                    title_el = el.find_element("css selector", "h3")
                    link_el = el.find_element("css selector", "a")
                    snippet_el = None
                    for sel in [".VwiC3b", ".Uroaid", ".lyLwlc"]:
                        try:
                            snippet_el = el.find_element("css selector", sel)
                            break
                        except Exception:
                            pass
                    organic.append({
                        "title": title_el.text.strip() if title_el else "",
                        "link": link_el.get_attribute("href") or "",
                        "snippet": snippet_el.text.strip() if snippet_el else "",
                    })
                except Exception:
                    pass

            # Try to grab AI overview
            ai_response = None
            for sel in [".M8OgIe", "[data-attrid='wa:/description']"]:
                try:
                    ai_el = sb.find_element(sel)
                    ai_response = ai_el.text.strip()
                    if ai_response:
                        break
                except Exception:
                    pass

            return {"organic": organic, "aiResponse": ai_response}
    except Exception as e:
        print(f"Search Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ExtractHtmlRequest(BaseModel):
    html: str

@app.post("/extract_html")
def extract_html(req: ExtractHtmlRequest):
    try:
        from mineru_html import MinerUHTML_Transformers, MinerUHTMLConfig
        global html_extractor
        if "html_extractor" not in globals():
            config = MinerUHTMLConfig(use_fall_back='trafilatura', early_load=True)
            html_extractor = MinerUHTML_Transformers(config=config)
        
        result = html_extractor.process(req.html)
        return {"content": result[0].output_data.main_content}
    except Exception as e:
        print(f"HTML Extraction Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
