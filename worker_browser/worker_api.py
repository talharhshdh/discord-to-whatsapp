from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from seleniumbase import SB
import uvicorn
import random

app = FastAPI(title="Worker Browser API")

class ScrapeIndeedRequest(BaseModel):
    query: str
    location: str
    page: int = 1

def is_captcha_present(sb):
    """
    Checks the current page state for common captcha and verification indicators.
    Returns True if a captcha/challenge page is detected.
    """
    try:
        title = sb.get_title()
        if "Just a moment..." in title or "Attention Required" in title:
            return True
        
        source = sb.get_page_source()
        if "Verify you are human" in source or "Additional Verification Required" in source:
            return True
            
        if sb.is_element_visible("form[action='/sorry/index']") or sb.is_element_visible("#captcha") or sb.is_element_visible(".g-recaptcha"):
            return True
            
    except Exception:
        return True
    return False

@app.post("/scrape/indeed")
def scrape_indeed(req: ScrapeIndeedRequest):
    try:
        # We run headlessly with UC mode inside SB
        with SB(uc=True, headless=True) as sb:
            sb.driver.set_window_size(1400, 900)
            
            start_offset = (req.page - 1) * 10
            
            domain = "www.indeed.com"
            if req.location and any(p in req.location.lower() for p in ["pakistan", "pk", "rawalpindi", "islamabad", "lahore", "karachi", "punjab", "sindh", "kpk", "balochistan"]):
                domain = "pk.indeed.com"
            
            search_url = f"https://{domain}/jobs?q={req.query}&l={req.location}&start={start_offset}"
            print(f"[Indeed UC] Navigating to: {search_url}")
            
            sb.uc_open_with_reconnect(search_url, 6)
            sb.sleep(3)
            
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

@app.get("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
