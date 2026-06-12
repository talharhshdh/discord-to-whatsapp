from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel
from seleniumbase import SB
import uvicorn
import random
import tempfile
import os
import asyncio

app = FastAPI(title="Worker Browser API")

browser_semaphore = asyncio.Semaphore(1)

class ScrapeIndeedRequest(BaseModel):
    query: str
    location: str
    page: int = 1

class ScreenshotRequest(BaseModel):
    url: str
    full_page: bool = False

class GetHtmlRequest(BaseModel):
    url: str

def is_captcha_present(sb):
    """
    Checks the current page state for common captcha and verification indicators.
    Returns True if a captcha/challenge page is detected.
    """
    try:
        title = sb.get_title()
        if "Just a moment..." in title or "Attention Required" in title or "Security | Indeed" in title:
            return True
        
        source = sb.get_page_source()
        if "Verify you are human" in source or "Additional Verification Required" in source or "hcaptcha" in source or "g-recaptcha" in source:
            return True
            
        if sb.is_element_visible("form[action='/sorry/index']") or sb.is_element_visible("#captcha") or sb.is_element_visible(".g-recaptcha"):
            return True
            
    except Exception:
        return False
    return False

def sync_scrape_indeed(req: ScrapeIndeedRequest):
    try:
        # We run headlessly with UC mode inside SB
        with SB(uc=True, xvfb=True) as sb:
            sb.driver.set_window_size(1400, 900)
            
            start_offset = (req.page - 1) * 10
            
            domain = "www.indeed.com"
            if req.location and any(p in req.location.lower() for p in ["pakistan", "pk", "rawalpindi", "islamabad", "lahore", "karachi", "punjab", "sindh", "kpk", "balochistan"]):
                domain = "pk.indeed.com"
            
            import urllib.parse
            safe_query = urllib.parse.quote_plus(req.query)
            safe_location = urllib.parse.quote_plus(req.location)
            search_url = f"https://{domain}/jobs?q={safe_query}&l={safe_location}&start={start_offset}"
            print(f"[Indeed UC] Navigating to: {search_url}")
            
            sb.uc_open_with_reconnect(search_url, 6)
            sb.sleep(2)
            print(f"[Indeed UC] Loaded URL: {sb.get_current_url()}")
            
            # Try to bypass Cloudflare Turnstile if present
            for attempt in range(3):
                if not is_captcha_present(sb):
                    break
                print(f"[Indeed UC] Bypassing captcha (attempt {attempt + 1})...")
                try:
                    if sb.is_element_present("iframe[src*='challenges']"):
                        sb.sleep(2)
                    sb.uc_gui_click_captcha()
                    sb.sleep(5)
                except Exception as e:
                    print(f"[Indeed UC] Click captcha error: {e}")
                
                if not is_captcha_present(sb):
                    break
                
                try:
                    sb.uc_gui_handle_captcha()
                    sb.sleep(5)
                except Exception as e:
                    print(f"[Indeed UC] Handle captcha error: {e}")
            
            # Check for captcha
            if is_captcha_present(sb):
                print("[Indeed UC] Captcha detected on search page! Aborting.")
                raise HTTPException(status_code=403, detail="Captcha detected on search page")

            # Wait for job cards
            try:
                sb.wait_for_element(".job_seen_beacon, a.jcs-JobTitle", timeout=12)
            except Exception:
                if is_captcha_present(sb):
                    raise HTTPException(status_code=403, detail="Captcha detected on search page timeout")
                
                # Take a diagnostic screenshot to help the test kit see what happened
                try:
                    temp_dir = tempfile.gettempdir()
                    screenshot_path = os.path.join(temp_dir, "indeed_timeout_debug.png")
                    html_path = os.path.join(temp_dir, "indeed_timeout_debug.html")
                    sb.save_screenshot(screenshot_path)
                    with open(html_path, "w", encoding="utf-8") as f:
                        f.write(sb.get_page_source())
                    print(f"[Indeed UC] Timeout waiting for cards. Saved diagnostic screenshot to {screenshot_path} and html to {html_path}.")
                except Exception:
                    pass
                return []

            # Extract job cards
            jobs_on_page = sb.execute_script(f"""
                var elements = document.querySelectorAll('.job_seen_beacon');
                var results = [];
                elements.forEach(function(el) {{
                    var titleEl = el.querySelector('a.jcs-JobTitle') || el.querySelector('span[id^="jobTitle-"]');
                    var title = titleEl ? titleEl.innerText.trim() : '';
                    var jk = titleEl ? titleEl.getAttribute('data-jk') : null;
                    
                    var companyEl = el.querySelector('[data-testid="company-name"]') || el.querySelector('.companyName');
                    var company = companyEl ? companyEl.innerText.trim() : '';
                    
                    var locationEl = el.querySelector('[data-testid="text-location"]') || el.querySelector('.companyLocation');
                    var location = locationEl ? locationEl.innerText.trim() : '';
                    
                    var salaryEl = el.querySelector('[data-testid="attribute_snippet_type_salary-estimate"]') || el.querySelector('.salary-snippet-container');
                    var salary = salaryEl ? salaryEl.innerText.trim() : '';
                    
                    var snippetEl = el.querySelector('.job-snippet') || el.querySelector('.summary');
                    var snippet = snippetEl ? snippetEl.innerText.trim() : '';
                    
                    if (jk) {{
                        results.push({{
                            'jk': jk,
                            'title': title,
                            'company': company,
                            'location': location,
                            'salary': salary,
                            'snippet': snippet,
                            'url': 'https://{domain}/viewjob?jk=' + jk
                        }});
                    }}
                }});
                return results;
            """)

            if not jobs_on_page:
                return []

            scraped_jobs = []
            for job in jobs_on_page:
                jk = job['jk']
                
                # Single tab click card
                try:
                    card_selector = f'a.jcs-JobTitle[data-jk="{jk}"], [id^="jobTitle-"][data-jk="{jk}"]'
                    sb.click(card_selector)
                    sb.sleep(2)
                    
                    if is_captcha_present(sb):
                        print("[Indeed UC] Captcha detected after click! Aborting.")
                        raise HTTPException(status_code=403, detail="Captcha detected after job click")

                    sb.wait_for_element("#jobDescriptionText", timeout=6)
                    description = sb.get_text("#jobDescriptionText").strip()
                    job['description'] = description
                except Exception as e:
                    if is_captcha_present(sb):
                        raise HTTPException(status_code=403, detail="Captcha detected during description fetch")
                    job['description'] = job['snippet'] # Fallback
                
                scraped_jobs.append(job)
                sb.sleep(random.uniform(0.5, 1.2))

            return scraped_jobs
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def sync_take_screenshot(req: ScreenshotRequest):
    try:
        with SB(uc=True, xvfb=True) as sb:
            sb.driver.set_window_size(1400, 900)
            sb.uc_open_with_reconnect(req.url, 5)
            sb.sleep(4)
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
        raise HTTPException(status_code=500, detail=str(e))

def sync_get_html(req: GetHtmlRequest):
    try:
        with SB(uc=True, xvfb=True) as sb:
            sb.uc_open_with_reconnect(req.url, 5)
            sb.sleep(4)
            return {"html": sb.get_page_source()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/scrape/indeed")
async def scrape_indeed(req: ScrapeIndeedRequest):
    async with browser_semaphore:
        return await asyncio.to_thread(sync_scrape_indeed, req)

@app.post("/screenshot")
async def take_screenshot(req: ScreenshotRequest):
    async with browser_semaphore:
        return await asyncio.to_thread(sync_take_screenshot, req)

@app.post("/get_html")
async def get_html(req: GetHtmlRequest):
    async with browser_semaphore:
        return await asyncio.to_thread(sync_get_html, req)

@app.get("/logs")
def get_logs():
    try:
        log_path = "/tmp/worker_api.log"
        if os.path.exists(log_path):
            with open(log_path, "r", encoding="utf-8") as f:
                # return last 100 lines or full logs
                lines = f.readlines()
                return {"logs": "".join(lines[-200:])}
        return {"logs": "Log file not found"}
    except Exception as e:
        return {"logs": f"Error reading log: {str(e)}"}

@app.get("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
