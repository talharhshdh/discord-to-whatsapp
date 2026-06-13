package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

type TunnelOptions struct {
	ServiceName    string
	DomainMode     string
	CustomDomain   string
	HostPort       int
	SessionHash    string
	CleanName      string
	ReuseTunnel    bool
	OldTunnelToken string
	OldTunnelID    string
}

type TunnelResult struct {
	TunnelID       string
	TunnelToken    string
	TunnelPid      int
	CloudflaredURL string
}

func callCloudflareAPI(method, urlStr string, body []byte, apiToken string) (map[string]interface{}, error) {
	var bodyReader *bytes.Buffer
	if body != nil {
		bodyReader = bytes.NewBuffer(body)
	}
	var req *http.Request
	var err error
	if bodyReader != nil {
		req, err = http.NewRequest(method, urlStr, bodyReader)
	} else {
		req, err = http.NewRequest(method, urlStr, nil)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to create http request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request failed: %w", err)
	}
	defer resp.Body.Close()

	var res map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("failed to decode response (status %d): %w", resp.StatusCode, err)
	}

	if resp.StatusCode >= 400 {
		var errMsgs []string
		if errs, ok := res["errors"].([]interface{}); ok {
			for _, e := range errs {
				if eMap, ok := e.(map[string]interface{}); ok {
					if msg, ok := eMap["message"].(string); ok {
						errMsgs = append(errMsgs, msg)
					}
				}
			}
		}
		if len(errMsgs) > 0 {
			return nil, fmt.Errorf("Cloudflare API error (status %d): %s", resp.StatusCode, strings.Join(errMsgs, ", "))
		}
		return nil, fmt.Errorf("Cloudflare API error (status %d)", resp.StatusCode)
	}

	if success, ok := res["success"].(bool); ok && !success {
		return nil, fmt.Errorf("Cloudflare API reported success: false")
	}

	return res, nil
}

func provisionTunnel(opts TunnelOptions) (TunnelResult, error) {
	var res TunnelResult

	// Wait for the container/service port to start listening
	log.Printf("[Cloudflare Tunnel] Waiting for port %d to start listening...", opts.HostPort)
	if !waitForPort(opts.HostPort, 15*time.Second) {
		log.Printf("[Cloudflare Tunnel] Warning: Port %d did not start listening within timeout. Connecting tunnel anyway...", opts.HostPort)
	} else {
		log.Printf("[Cloudflare Tunnel] Port %d is active. Setting up tunnel...", opts.HostPort)
	}

	if opts.DomainMode == "custom" {
		res.CloudflaredURL = opts.CustomDomain
		if !strings.HasPrefix(res.CloudflaredURL, "http") {
			res.CloudflaredURL = "https://" + res.CloudflaredURL
		}
		hostnameOnly := strings.TrimPrefix(strings.TrimPrefix(res.CloudflaredURL, "https://"), "http://")

		accountID := getSanitizedEnv("CLOUDFLARE_ACCOUNT_ID")
		zoneID := getSanitizedEnv("CLOUDFLARE_ZONE_ID")
		apiToken := getSanitizedEnv("CLOUDFLARE_API_TOKEN")

		res.TunnelToken = opts.OldTunnelToken
		res.TunnelID = opts.OldTunnelID

		if !opts.ReuseTunnel || res.TunnelToken == "" {
			if accountID == "" || zoneID == "" || apiToken == "" {
				return res, errors.New("missing Cloudflare Credentials (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN)")
			}

			log.Printf("[Cloudflare Tunnel] Auto-configuring Cloudflare Tunnel for %s...", opts.ServiceName)
			tSecretBytes := make([]byte, 32)
			if _, err := rand.Read(tSecretBytes); err != nil {
				return res, fmt.Errorf("failed to generate secure random bytes: %w", err)
			}
			tSecretBase64 := base64.StdEncoding.EncodeToString(tSecretBytes)
			tunnelName := fmt.Sprintf("tunnel-%s-%s-%s", opts.CleanName, opts.SessionHash, generateHash())

			// 1. Create Tunnel
			tBody, _ := json.Marshal(map[string]string{
				"name":          tunnelName,
				"tunnel_secret": tSecretBase64,
			})
			urlStr := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel", accountID)
			apiRes, err := callCloudflareAPI("POST", urlStr, tBody, apiToken)
			if err != nil {
				return res, fmt.Errorf("failed to create tunnel: %w", err)
			}
			if result, _ := apiRes["result"].(map[string]interface{}); result != nil {
				res.TunnelID, _ = result["id"].(string)
			}
			if res.TunnelID == "" {
				return res, errors.New("cloudflare tunnel ID not returned in response")
			}

			// 2. Configure Ingress Rules
			ingressBody, _ := json.Marshal(map[string]interface{}{
				"config": map[string]interface{}{
					"ingress": []map[string]interface{}{
						{"hostname": hostnameOnly, "service": fmt.Sprintf("http://127.0.0.1:%d", opts.HostPort)},
						{"service": "http_status:404"},
					},
				},
			})
			urlStr = fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, res.TunnelID)
			_, err = callCloudflareAPI("PUT", urlStr, ingressBody, apiToken)
			if err != nil {
				// Cleanup the created tunnel before returning error
				_ = deleteCloudflareTunnelOnly(res.TunnelID, accountID, apiToken)
				return res, fmt.Errorf("failed to configure ingress rules: %w", err)
			}

			// 3. Create or Update DNS CNAME Mapping
			var dnsRecordID = ""
			dnsListUrl := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records?name=%s&type=CNAME", zoneID, hostnameOnly)
			dnsListRes, err := callCloudflareAPI("GET", dnsListUrl, nil, apiToken)
			if err != nil {
				_ = deleteCloudflareTunnelOnly(res.TunnelID, accountID, apiToken)
				return res, fmt.Errorf("failed to list DNS records: %w", err)
			}
			if results, ok := dnsListRes["result"].([]interface{}); ok && len(results) > 0 {
				if record, ok := results[0].(map[string]interface{}); ok {
					dnsRecordID, _ = record["id"].(string)
				}
			}

			dnsUrl := ""
			dnsMethod := ""
			if dnsRecordID != "" {
				dnsUrl = fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records/%s", zoneID, dnsRecordID)
				dnsMethod = "PUT"
			} else {
				dnsUrl = fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records", zoneID)
				dnsMethod = "POST"
			}

			dnsBody, _ := json.Marshal(map[string]interface{}{
				"type":    "CNAME",
				"name":    hostnameOnly,
				"content": fmt.Sprintf("%s.cfargotunnel.com", res.TunnelID),
				"proxied": true,
			})
			_, err = callCloudflareAPI(dnsMethod, dnsUrl, dnsBody, apiToken)
			if err != nil {
				_ = deleteCloudflareTunnelOnly(res.TunnelID, accountID, apiToken)
				return res, fmt.Errorf("failed to set DNS CNAME record: %w", err)
			}

			// Token base64
			tokenPayload := map[string]string{"a": accountID, "t": res.TunnelID, "s": tSecretBase64}
			tokenJson, _ := json.Marshal(tokenPayload)
			res.TunnelToken = base64.StdEncoding.EncodeToString(tokenJson)
		} else {
			if res.TunnelID == "" && res.TunnelToken != "" {
				if decodedBytes, err := base64.StdEncoding.DecodeString(res.TunnelToken); err == nil {
					var decoded map[string]interface{}
					if err := json.Unmarshal(decodedBytes, &decoded); err == nil {
						if t, ok := decoded["t"].(string); ok {
							res.TunnelID = t
						}
					}
				}
			}

			if res.TunnelID != "" && accountID != "" && apiToken != "" {
				log.Printf("[Cloudflare Tunnel] Updating Ingress Rules for existing Cloudflare Tunnel %s...", res.TunnelID)
				ingressBody, _ := json.Marshal(map[string]interface{}{
					"config": map[string]interface{}{
						"ingress": []map[string]interface{}{
							{"hostname": hostnameOnly, "service": fmt.Sprintf("http://127.0.0.1:%d", opts.HostPort)},
							{"service": "http_status:404"},
						},
					},
				})
				urlStr := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, res.TunnelID)
				_, err := callCloudflareAPI("PUT", urlStr, ingressBody, apiToken)
				if err != nil {
					return res, fmt.Errorf("failed to update ingress rules: %w", err)
				}
			}
		}

		if res.TunnelToken != "" {
			tCmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "run", "--token", res.TunnelToken)
			if err := tCmd.Start(); err == nil {
				res.TunnelPid = tCmd.Process.Pid
				return res, nil
			} else {
				return res, fmt.Errorf("failed to start cloudflared tunnel command: %w", err)
			}
		}
		return res, errors.New("cloudflare tunnel token is empty")
	}

	if opts.DomainMode == "quick" {
		tCmd := exec.Command("cloudflared", "tunnel", "--url", fmt.Sprintf("http://127.0.0.1:%d", opts.HostPort))
		stderr, err := tCmd.StderrPipe()
		if err != nil {
			return res, fmt.Errorf("failed to open stderr pipe for cloudflared: %w", err)
		}

		if err := tCmd.Start(); err != nil {
			return res, fmt.Errorf("failed to start cloudflared quick tunnel: %w", err)
		}

		res.TunnelPid = tCmd.Process.Pid
		urlChan := make(chan string, 1)
		errChan := make(chan error, 1)

		go func() {
			buf := make([]byte, 1024)
			var accumulated string
			re := regexp.MustCompile(`https://[-0-9a-z]*\.trycloudflare\.com`)
			urlSent := false
			
			for {
				n, err := stderr.Read(buf)
				if n > 0 {
					if !urlSent {
						accumulated += string(buf[:n])
						if match := re.FindString(accumulated); match != "" {
							urlChan <- match
							urlSent = true
						}
					}
				}
				if err != nil {
					if !urlSent {
						errChan <- err
					}
					return
				}
			}
		}()

		select {
		case cUrl := <-urlChan:
			res.CloudflaredURL = cUrl
			return res, nil
		case <-errChan:
			tCmd.Process.Kill()
			return res, errors.New("cloudflare quick tunnel failed to write URL to stderr")
		case <-time.After(30 * time.Second):
			tCmd.Process.Kill()
			return res, errors.New("cloudflare quick tunnel timed out")
		}
	}

	return res, fmt.Errorf("unknown domain mode: %s", opts.DomainMode)
}

func deleteCloudflareTunnelOnly(tunnelID, accountID, apiToken string) error {
	if tunnelID == "" || accountID == "" || apiToken == "" {
		return nil
	}
	url := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s", accountID, tunnelID)
	req, _ := http.NewRequest("DELETE", url, nil)
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
	return err
}

func cleanupCloudflareResources(meta SessionMetadata) {
	if meta.TunnelPid > 0 {
		if proc, err := os.FindProcess(meta.TunnelPid); err == nil {
			_ = proc.Kill()
			log.Printf("[Cloudflare Cleanup] Killed tunnel process PID %d", meta.TunnelPid)
		}
	}

	accountID := getSanitizedEnv("CLOUDFLARE_ACCOUNT_ID")
	zoneID := getSanitizedEnv("CLOUDFLARE_ZONE_ID")
	apiToken := getSanitizedEnv("CLOUDFLARE_API_TOKEN")

	if meta.TunnelID != "" && accountID != "" && apiToken != "" {
		log.Printf("[Cloudflare Cleanup] Deleting Cloudflare tunnel %s...", meta.TunnelID)
		time.Sleep(2 * time.Second)
		_ = deleteCloudflareTunnelOnly(meta.TunnelID, accountID, apiToken)
	}

	if meta.CustomDomain != "" && zoneID != "" && apiToken != "" {
		hostname := strings.TrimPrefix(meta.CustomDomain, "https://")
		hostname = strings.TrimPrefix(hostname, "http://")
		log.Printf("[Cloudflare Cleanup] Cleaning up DNS CNAME record for %s...", hostname)

		url := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records?name=%s&type=CNAME", zoneID, hostname)
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("Authorization", "Bearer "+apiToken)

		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			defer resp.Body.Close()
			var dnsList map[string]interface{}
			json.NewDecoder(resp.Body).Decode(&dnsList)
			if success, _ := dnsList["success"].(bool); success {
				results, _ := dnsList["result"].([]interface{})
				if len(results) > 0 {
					record, _ := results[0].(map[string]interface{})
					recordID, _ := record["id"].(string)

					delUrl := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records/%s", zoneID, recordID)
					delReq, _ := http.NewRequest("DELETE", delUrl, nil)
					delReq.Header.Set("Authorization", "Bearer "+apiToken)

					if delResp, err := http.DefaultClient.Do(delReq); err == nil {
						delResp.Body.Close()
						log.Printf("[Cloudflare Cleanup] Deleted DNS record for %s", hostname)
					}
				}
			}
		}
	}
}

func waitForPort(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
		if err == nil {
			conn.Close()
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}
