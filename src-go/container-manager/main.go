package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

type ServiceSessionMetadata struct {
	ServiceName    string `json:"serviceName"`
	Port           int    `json:"port"`
	HostPort       int    `json:"hostPort"`
	DomainMode     string `json:"domainMode"`
	CustomDomain   string `json:"customDomain,omitempty"`
	CloudflaredURL string `json:"cloudflaredUrl,omitempty"`
	TunnelPid      int    `json:"tunnelPid,omitempty"`
	TunnelToken    string `json:"tunnelToken,omitempty"`
	TunnelID       string `json:"tunnelId,omitempty"`
}

// Session structure matching TS backend
type SessionMetadata struct {
	Port           int                               `json:"port,omitempty"`
	HostPort       int                               `json:"hostPort,omitempty"`
	ContainerName  string                            `json:"containerName,omitempty"`
	TargetURL      string                            `json:"targetUrl,omitempty"`
	Image          string                            `json:"image,omitempty"`
	Env            map[string]string                 `json:"env,omitempty"`
	DomainMode     string                            `json:"domainMode,omitempty"`
	CustomDomain   string                            `json:"customDomain,omitempty"`
	TunnelPid      int                               `json:"tunnelPid,omitempty"`
	CloudflaredURL string                            `json:"cloudflaredUrl,omitempty"`
	WebhookSecret  string                            `json:"webhookSecret,omitempty"`
	TunnelToken    string                            `json:"tunnelToken,omitempty"`
	TunnelID       string                            `json:"tunnelId,omitempty"`
	ComposeFile    string                            `json:"composeFile,omitempty"`
	Services       map[string]ServiceSessionMetadata `json:"services,omitempty"`
}

type Session struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	URL       string          `json:"url"`
	Username  string          `json:"username,omitempty"`
	Password  string          `json:"password,omitempty"`
	StartedAt time.Time       `json:"startedAt"`
	Metadata  SessionMetadata `json:"metadata,omitempty"`
}

type StartRequest struct {
	Image             string            `json:"image"`
	Port              int               `json:"port"`
	Env               map[string]string `json:"env"`
	Name              string            `json:"name"`
	DomainMode        string            `json:"domainMode"`
	CustomDomain      string            `json:"customDomain"`
	HostPort          int               `json:"hostPort"`
	TunnelToken       string            `json:"tunnelToken"`
	ExistingSessionID string            `json:"sessionId"`
}

type StopRequest struct {
	SessionID string `json:"sessionId"`
}

var (
	sessionsMu   sync.RWMutex
	sessions     = make(map[string]Session)
	sessionsFile string
	nextPort     = 16000
	nextPortMu   sync.Mutex
)

func main() {
	log.Println("[Go Container Manager] Starting server...")

	// 1. Locate workspace root and load .env
	root := findWorkspaceRoot()
	loadEnv(filepath.Join(root, ".env"))

	sessionsFile = filepath.Join(root, "auth_info", "go_sessions.json")
	log.Printf("[Go Container Manager] Workspace Root: %s", root)
	log.Printf("[Go Container Manager] Sessions File: %s", sessionsFile)

	// 2. Load existing sessions from disk
	if err := loadSessions(); err != nil {
		log.Printf("[Go Container Manager] Warning: failed to load sessions: %v", err)
	}

	// 3. Restore any running containers/tunnels
	go restoreDockerContainers()

	// 4. Setup HTTP routes
	http.HandleFunc("/api/go/containers/sessions", handleGetSessions)
	http.HandleFunc("/api/go/containers/start", handleStartContainer)
	http.HandleFunc("/api/go/containers/stop", handleStopContainer)
	http.HandleFunc("/api/go/containers/compose/parse", handleParseCompose)
	http.HandleFunc("/api/go/containers/compose/deploy", handleDeployCompose)

	// Start server
	log.Println("[Go Container Manager] Listening on port 18080...")
	if err := http.ListenAndServe("127.0.0.1:18080", nil); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

// Locate workspace root by looking for package.json
func findWorkspaceRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "."
}

// Load env variables from a .env file
func loadEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		val = strings.Trim(val, `'"`)
		os.Setenv(key, val)
	}
}

// Load sessions from disk
func loadSessions() error {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	if _, err := os.Stat(sessionsFile); os.IsNotExist(err) {
		return nil
	}

	data, err := os.ReadFile(sessionsFile)
	if err != nil {
		return err
	}

	var sessList []Session
	if err := json.Unmarshal(data, &sessList); err != nil {
		return err
	}

	for _, s := range sessList {
		sessions[s.ID] = s
	}
	log.Printf("[Go Container Manager] Loaded %d sessions from disk.", len(sessions))
	return nil
}

// Save sessions to disk and trigger R2 backup
func saveSessions() {
	sessionsMu.Lock()
	sessList := make([]Session, 0, len(sessions))
	for _, s := range sessions {
		sessList = append(sessList, s)
	}
	sessionsMu.Unlock()

	// Ensure directory exists
	dir := filepath.Dir(sessionsFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		log.Printf("Error creating sessions folder: %v", err)
		return
	}

	data, err := json.MarshalIndent(sessList, "", "  ")
	if err != nil {
		log.Printf("Error marshaling sessions: %v", err)
		return
	}

	if err := os.WriteFile(sessionsFile, data, 0644); err != nil {
		log.Printf("Error writing sessions: %v", err)
		return
	}

	// Trigger R2 upload in background
	go func() {
		if err := saveStateToR2(); err != nil {
			log.Printf("❌ Failed to sync state to R2: %v", err)
		}
	}()
}

// trigger Node.js script to sync to Cloudflare R2
func saveStateToR2() error {
	root := findWorkspaceRoot()
	// Node script requires compiled JS. We run the exact same logic.
	cmd := exec.Command("node", "-e", "require('./dist/libs/r2-sync').saveStateToR2()")
	cmd.Dir = root

	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	err := cmd.Run()
	if err != nil {
		return fmt.Errorf("R2 sync failed: %w (stderr: %s)", err, errBuf.String())
	}
	log.Printf("[R2-Sync Go Bridge] Node script output: %s", strings.TrimSpace(outBuf.String()))
	return nil
}

func getSanitizedEnv(key string) string {
	raw := os.Getenv(key)
	return strings.TrimSpace(strings.Trim(raw, `'"'`))
}

func generateHash() string {
	b := make([]byte, 4)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
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

		url := fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s", accountID, meta.TunnelID)
		req, _ := http.NewRequest("DELETE", url, nil)
		req.Header.Set("Authorization", "Bearer "+apiToken)
		req.Header.Set("Content-Type", "application/json")

		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			log.Printf("[Cloudflare Cleanup] Triggered tunnel deletion for %s", meta.TunnelID)
		}
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

// RESTORE containers and tunnels upon reboot
func restoreDockerContainers() {
	log.Println("[Docker Restore] Restoring running containers...")
	sessionsMu.RLock()
	var toRestore []Session
	for _, s := range sessions {
		if s.Type == "docker-container" || s.Type == "docker-compose" {
			toRestore = append(toRestore, s)
		}
	}
	sessionsMu.RUnlock()

	for _, s := range toRestore {
		go func(sess Session) {
			meta := sess.Metadata
			if sess.Type == "docker-compose" {
				log.Printf("[Docker Restore] Restoring compose stack %s...", sess.ID)
				_ = exec.Command("docker", "compose", "-f", meta.ComposeFile, "up", "-d").Run()
				_ = exec.Command("docker-compose", "-f", meta.ComposeFile, "up", "-d").Run()

				updatedServices := make(map[string]ServiceSessionMetadata)
				for name, svc := range meta.Services {
					if svc.DomainMode == "custom" {
						if svc.TunnelToken != "" {
							tCmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "run", "--token", svc.TunnelToken)
							if err := tCmd.Start(); err == nil {
								svc.TunnelPid = tCmd.Process.Pid
							}
						}
					} else if svc.DomainMode == "quick" {
						tCmd := exec.Command("cloudflared", "tunnel", "--url", fmt.Sprintf("http://localhost:%d", svc.HostPort))
						stderr, err := tCmd.StderrPipe()
						if err == nil && tCmd.Start() == nil {
							svc.TunnelPid = tCmd.Process.Pid
							go func(serviceName string, sID string, hostPort int) {
								scanner := bufio.NewScanner(stderr)
								re := regexp.MustCompile(`https://[-0-9a-z]*\.trycloudflare\.com`)
								for scanner.Scan() {
									line := scanner.Text()
									if match := re.FindString(line); match != "" {
										sessionsMu.Lock()
										if s, ok := sessions[sID]; ok {
											if svcMeta, ok2 := s.Metadata.Services[serviceName]; ok2 {
												svcMeta.CloudflaredURL = match
												s.Metadata.Services[serviceName] = svcMeta
												if s.URL == "" || strings.Contains(s.URL, "trycloudflare.com") || s.URL == "http://localhost" {
													s.URL = match
												}
												sessions[sID] = s
											}
										}
										sessionsMu.Unlock()
										saveSessions()
										break
									}
								}
							}(name, sess.ID, svc.HostPort)
						}
					}
					updatedServices[name] = svc
				}

				sessionsMu.Lock()
				if s, ok := sessions[sess.ID]; ok {
					s.Metadata.Services = updatedServices
					sessions[sess.ID] = s
				}
				sessionsMu.Unlock()
				saveSessions()
				return
			}

			// Check if container is running
			cmd := exec.Command("docker", "ps", "--filter", "name="+meta.ContainerName, "--format", "{{.Names}}")
			out, _ := cmd.Output()
			isRunning := strings.TrimSpace(string(out)) == meta.ContainerName

			if !isRunning {
				log.Printf("[Docker Restore] Starting container %s...", meta.ContainerName)
				_ = exec.Command("docker", "pull", meta.Image).Run()

				envArgs := []string{"run", "-d", "--rm", "--name", meta.ContainerName}
				for k, v := range meta.Env {
					envArgs = append(envArgs, "-e", fmt.Sprintf("%s=%s", k, v))
				}
				envArgs = append(envArgs, "-p", fmt.Sprintf("%d:%d", meta.HostPort, meta.Port), meta.Image)
				_ = exec.Command("docker", envArgs...).Run()
			}

			// Restore Tunnel
			if meta.DomainMode == "custom" {
				if meta.TunnelToken != "" {
					tCmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "run", "--token", meta.TunnelToken)
					if err := tCmd.Start(); err == nil {
						sess.Metadata.TunnelPid = tCmd.Process.Pid
						sessionsMu.Lock()
						sessions[sess.ID] = sess
						sessionsMu.Unlock()
					}
				}
			} else {
				// Quick Tunnel
				tCmd := exec.Command("cloudflared", "tunnel", "--url", fmt.Sprintf("http://localhost:%d", meta.HostPort))
				stderr, err := tCmd.StderrPipe()
				if err == nil && tCmd.Start() == nil {
					sess.Metadata.TunnelPid = tCmd.Process.Pid
					sessionsMu.Lock()
					sessions[sess.ID] = sess
					sessionsMu.Unlock()

					go func() {
						scanner := bufio.NewScanner(stderr)
						re := regexp.MustCompile(`https://[-0-9a-z]*\.trycloudflare\.com`)
						for scanner.Scan() {
							line := scanner.Text()
							if match := re.FindString(line); match != "" {
								sessionsMu.Lock()
								if s, ok := sessions[sess.ID]; ok {
									s.URL = match
									s.Metadata.CloudflaredURL = match
									sessions[sess.ID] = s
								}
								sessionsMu.Unlock()
								saveSessions()
								break
							}
						}
					}()
				}
			}
		}(s)
	}
}

// HTTP HANDLERS
func handleGetSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	sessionsMu.RLock()
	list := make([]Session, 0, len(sessions))
	for _, s := range sessions {
		list = append(list, s)
	}
	sessionsMu.RUnlock()

	json.NewEncoder(w).Encode(list)
}

type ParseComposeRequest struct {
	YAML string `json:"yaml"`
}

func handleParseCompose(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	if r.Method == "OPTIONS" {
		return
	}

	var req ParseComposeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	normalized, err := ParseAndNormalizeCompose([]byte(req.YAML))
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}

	json.NewEncoder(w).Encode(normalized)
}

func handleStartContainer(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == "OPTIONS" {
		return
	}

	var req StartRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// 1. Verify Docker is running
	if err := exec.Command("docker", "--version").Run(); err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Docker is not running on the host system."})
		return
	}

	hash := req.ExistingSessionID
	if hash == "" {
		hash = generateHash()
	} else {
		hash = strings.TrimPrefix(hash, "docker-")
	}
	sessionID := "docker-" + hash

	// Clean up old instance first if updating
	sessionsMu.Lock()
	oldSess, exists := sessions[sessionID]
	sessionsMu.Unlock()

	webhookSecret := generateHash()
	var activeTunnelToken = req.TunnelToken
	var activeTunnelID = ""
	var reuseTunnel = false

	if exists {
		webhookSecret = oldSess.Metadata.WebhookSecret
		log.Printf("[Docker Go Start] Stopping old container %s...", oldSess.Metadata.ContainerName)
		_ = exec.Command("docker", "stop", oldSess.Metadata.ContainerName).Run()

		targetURL := req.CustomDomain
		if targetURL != "" && !strings.HasPrefix(targetURL, "http") {
			targetURL = "https://" + targetURL
		}
		oldTargetURL := oldSess.Metadata.CustomDomain
		if oldTargetURL != "" && !strings.HasPrefix(oldTargetURL, "http") {
			oldTargetURL = "https://" + oldTargetURL
		}

		if req.DomainMode == "custom" &&
			oldSess.Metadata.DomainMode == "custom" &&
			oldSess.Metadata.TunnelToken != "" &&
			targetURL != "" &&
			targetURL == oldTargetURL {
			log.Printf("[Docker Go Deploy] Reusing existing Cloudflare tunnel token: %s", oldSess.Metadata.TunnelID)
			activeTunnelToken = oldSess.Metadata.TunnelToken
			activeTunnelID = oldSess.Metadata.TunnelID
			reuseTunnel = true

			if oldSess.Metadata.TunnelPid > 0 {
				if proc, err := os.FindProcess(oldSess.Metadata.TunnelPid); err == nil {
					_ = proc.Kill()
					log.Printf("[Cloudflare Cleanup] Killed tunnel process PID %d", oldSess.Metadata.TunnelPid)
				}
			}
		} else {
			cleanupCloudflareResources(oldSess.Metadata)
		}
	}

	cleanName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(req.Name, "_")
	if cleanName == "" {
		cleanName = "custom-app"
	}
	containerName := fmt.Sprintf("docker-custom-%s-%s", cleanName, hash)

	hostPort := req.HostPort
	if hostPort <= 0 {
		nextPortMu.Lock()
		hostPort = nextPort
		nextPort++
		nextPortMu.Unlock()
	}

	// Pull and run container
	log.Printf("[Docker Go Deploy] Pulling image %s...", req.Image)
	_ = exec.Command("docker", "pull", req.Image).Run()

	envArgs := []string{"run", "-d", "--rm", "--name", containerName}
	for k, v := range req.Env {
		envArgs = append(envArgs, "-e", fmt.Sprintf("%s=%s", k, v))
	}
	envArgs = append(envArgs, "-p", fmt.Sprintf("%d:%d", hostPort, req.Port), req.Image)

	log.Printf("[Docker Go Deploy] Starting container: docker %s", strings.Join(envArgs, " "))
	if err := exec.Command("docker", envArgs...).Run(); err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to run Docker container: " + err.Error()})
		return
	}

	var tunnelPid int
	var targetURL = ""

	if req.DomainMode == "custom" {
		if req.CustomDomain == "" {
			http.Error(w, "Custom domain is required for custom domain mode", http.StatusBadRequest)
			return
		}
		targetURL = req.CustomDomain
		if !strings.HasPrefix(targetURL, "http") {
			targetURL = "https://" + targetURL
		}
		hostname := strings.TrimPrefix(strings.TrimPrefix(targetURL, "https://"), "http://")

		accountID := getSanitizedEnv("CLOUDFLARE_ACCOUNT_ID")
		zoneID := getSanitizedEnv("CLOUDFLARE_ZONE_ID")
		apiToken := getSanitizedEnv("CLOUDFLARE_API_TOKEN")

		if !reuseTunnel && req.TunnelToken != "" {
			activeTunnelToken = req.TunnelToken
		}

		if activeTunnelToken == "" {
			if accountID != "" && zoneID != "" && apiToken != "" {
				// Auto create tunnel
				log.Println("[Docker Go Deploy] Auto-configuring Cloudflare Tunnel...")
				tSecret := generateHash() + generateHash() // 32 bytes hex
				tSecretBase64 := base64.StdEncoding.EncodeToString([]byte(tSecret))
				tunnelName := fmt.Sprintf("tunnel-%s-%s", cleanName, hash)

				// 1. Create Tunnel
				tBody, _ := json.Marshal(map[string]string{
					"name":          tunnelName,
					"tunnel_secret": tSecretBase64,
				})
				cReq, _ := http.NewRequest("POST", fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel", accountID), bytes.NewBuffer(tBody))
				cReq.Header.Set("Authorization", "Bearer "+apiToken)
				cReq.Header.Set("Content-Type", "application/json")
				if cResp, err := http.DefaultClient.Do(cReq); err == nil {
					defer cResp.Body.Close()
					var tunnelRes map[string]interface{}
					json.NewDecoder(cResp.Body).Decode(&tunnelRes)
					if result, _ := tunnelRes["result"].(map[string]interface{}); result != nil {
						activeTunnelID, _ = result["id"].(string)
					}
				}

				if activeTunnelID != "" {
					// 2. Configure Ingress Rules
					ingressBody, _ := json.Marshal(map[string]interface{}{
						"config": map[string]interface{}{
							"ingress": []map[string]interface{}{
								{"hostname": hostname, "service": fmt.Sprintf("http://localhost:%d", hostPort)},
								{"service": "http_status:404"},
							},
						},
					})
					cfReq, _ := http.NewRequest("PUT", fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, activeTunnelID), bytes.NewBuffer(ingressBody))
					cfReq.Header.Set("Authorization", "Bearer "+apiToken)
					cfReq.Header.Set("Content-Type", "application/json")
					if cfResp, err := http.DefaultClient.Do(cfReq); err == nil {
						cfResp.Body.Close()
					}

					// 3. Create or Update DNS CNAME Mapping
					var dnsRecordID = ""
					dnsListUrl := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records?name=%s&type=CNAME", zoneID, hostname)
					dnsListReq, _ := http.NewRequest("GET", dnsListUrl, nil)
					dnsListReq.Header.Set("Authorization", "Bearer "+apiToken)
					dnsListReq.Header.Set("Content-Type", "application/json")
					if dnsListResp, err := http.DefaultClient.Do(dnsListReq); err == nil {
						defer dnsListResp.Body.Close()
						var dnsList map[string]interface{}
						json.NewDecoder(dnsListResp.Body).Decode(&dnsList)
						if success, _ := dnsList["success"].(bool); success {
							results, _ := dnsList["result"].([]interface{})
							if len(results) > 0 {
								record, _ := results[0].(map[string]interface{})
								dnsRecordID, _ = record["id"].(string)
							}
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
						"name":    hostname,
						"content": fmt.Sprintf("%s.cfargotunnel.com", activeTunnelID),
						"proxied": true,
					})
					dnsReq, _ := http.NewRequest(dnsMethod, dnsUrl, bytes.NewBuffer(dnsBody))
					dnsReq.Header.Set("Authorization", "Bearer "+apiToken)
					dnsReq.Header.Set("Content-Type", "application/json")
					if dnsResp, err := http.DefaultClient.Do(dnsReq); err == nil {
						dnsResp.Body.Close()
					}

					// Token base64
					tokenPayload := map[string]string{"a": accountID, "t": activeTunnelID, "s": tSecretBase64}
					tokenJson, _ := json.Marshal(tokenPayload)
					activeTunnelToken = base64.StdEncoding.EncodeToString(tokenJson)
				}
			}
		} else {
			if activeTunnelID == "" && activeTunnelToken != "" {
				if decodedBytes, err := base64.StdEncoding.DecodeString(activeTunnelToken); err == nil {
					var decoded map[string]interface{}
					if err := json.Unmarshal(decodedBytes, &decoded); err == nil {
						if t, ok := decoded["t"].(string); ok {
							activeTunnelID = t
						}
					}
				}
			}
		}

		if reuseTunnel && accountID != "" && apiToken != "" && activeTunnelID != "" {
			log.Printf("[Docker Go Deploy] Updating Ingress Rules for existing Cloudflare Tunnel %s to point to port %d...", activeTunnelID, hostPort)
			ingressBody, _ := json.Marshal(map[string]interface{}{
				"config": map[string]interface{}{
					"ingress": []map[string]interface{}{
						{"hostname": hostname, "service": fmt.Sprintf("http://localhost:%d", hostPort)},
						{"service": "http_status:404"},
					},
				},
			})
			cfReq, _ := http.NewRequest("PUT", fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, activeTunnelID), bytes.NewBuffer(ingressBody))
			cfReq.Header.Set("Authorization", "Bearer "+apiToken)
			cfReq.Header.Set("Content-Type", "application/json")
			if cfResp, err := http.DefaultClient.Do(cfReq); err == nil {
				cfResp.Body.Close()
			}
		}

		if activeTunnelToken != "" {
			tCmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "run", "--token", activeTunnelToken)
			if err := tCmd.Start(); err == nil {
				tunnelPid = tCmd.Process.Pid
			}
		}

		sess := Session{
			ID:        sessionID,
			Type:      "docker-container",
			URL:       targetURL,
			StartedAt: time.Now(),
			Metadata: SessionMetadata{
				Port:           req.Port,
				HostPort:       hostPort,
				ContainerName:  containerName,
				Image:          req.Image,
				Env:            req.Env,
				DomainMode:     req.DomainMode,
				CustomDomain:   targetURL,
				CloudflaredURL: targetURL,
				TunnelPid:      tunnelPid,
				TunnelToken:    activeTunnelToken,
				TunnelID:       activeTunnelID,
				WebhookSecret:  webhookSecret,
			},
		}

		sessionsMu.Lock()
		sessions[sessionID] = sess
		sessionsMu.Unlock()
		saveSessions()

		json.NewEncoder(w).Encode(map[string]string{
			"url":           targetURL,
			"containerName": containerName,
		})
		return
	}

	// DomainMode Quick Tunnel
	tCmd := exec.Command("cloudflared", "tunnel", "--url", fmt.Sprintf("http://localhost:%d", hostPort))
	stderr, err := tCmd.StderrPipe()
	if err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to open stderr pipe for cloudflared: " + err.Error()})
		return
	}

	if err := tCmd.Start(); err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to start cloudflared quick tunnel: " + err.Error()})
		return
	}

	urlChan := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		re := regexp.MustCompile(`https://[-0-9a-z]*\.trycloudflare\.com`)
		for scanner.Scan() {
			line := scanner.Text()
			if match := re.FindString(line); match != "" {
				urlChan <- match
				break
			}
		}
	}()

	select {
	case cUrl := <-urlChan:
		sess := Session{
			ID:        sessionID,
			Type:      "docker-container",
			URL:       cUrl,
			StartedAt: time.Now(),
			Metadata: SessionMetadata{
				Port:           req.Port,
				HostPort:       hostPort,
				ContainerName:  containerName,
				Image:          req.Image,
				Env:            req.Env,
				DomainMode:     req.DomainMode,
				CloudflaredURL: cUrl,
				TunnelPid:      tCmd.Process.Pid,
				WebhookSecret:  webhookSecret,
			},
		}

		sessionsMu.Lock()
		sessions[sessionID] = sess
		sessionsMu.Unlock()
		saveSessions()

		json.NewEncoder(w).Encode(map[string]string{
			"url":           cUrl,
			"containerName": containerName,
		})
	case <-time.After(30 * time.Second):
		tCmd.Process.Kill()
		json.NewEncoder(w).Encode(map[string]string{"error": "Cloudflare Quick Tunnel timed out."})
	}
}

func handleStopContainer(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == "OPTIONS" {
		return
	}

	var req StopRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	sessionsMu.Lock()
	sess, exists := sessions[req.SessionID]
	if exists {
		delete(sessions, req.SessionID)
	}
	sessionsMu.Unlock()

	if !exists {
		json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "message": "Docker session not found"})
		return
	}

	meta := sess.Metadata
	if sess.Type == "docker-compose" {
		log.Printf("[Docker Go Stop] Stopping compose stack: %s", meta.ComposeFile)
		_ = exec.Command("docker", "compose", "-f", meta.ComposeFile, "down").Run()
		_ = exec.Command("docker-compose", "-f", meta.ComposeFile, "down").Run()

		for _, svc := range meta.Services {
			svcMeta := SessionMetadata{
				TunnelPid:    svc.TunnelPid,
				TunnelID:     svc.TunnelID,
				CustomDomain: svc.CustomDomain,
			}
			cleanupCloudflareResources(svcMeta)
		}
	} else {
		log.Printf("[Docker Go Stop] Stopping container: %s", meta.ContainerName)
		_ = exec.Command("docker", "stop", meta.ContainerName).Run()
		cleanupCloudflareResources(meta)
	}

	saveSessions()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Docker resources stopped and cleaned up.",
	})
}

type ServiceSetting struct {
	DomainMode   string            `json:"domainMode"`
	CustomDomain string            `json:"customDomain"`
	Env          map[string]string `json:"env"`
}

type DeployComposeRequest struct {
	YAML            string                    `json:"yaml"`
	ServiceSettings map[string]ServiceSetting `json:"serviceSettings"`
	SessionID       string                    `json:"sessionId,omitempty"`
}

func parsePorts(portStr string) (int, int, error) {
	parts := strings.Split(portStr, ":")
	if len(parts) == 1 {
		var containerPort int
		_, err := fmt.Sscanf(parts[0], "%d", &containerPort)
		return 0, containerPort, err
	} else if len(parts) == 2 {
		var hostPort, containerPort int
		_, err := fmt.Sscanf(parts[0], "%d", &hostPort)
		if err != nil {
			return 0, 0, err
		}
		_, err = fmt.Sscanf(parts[1], "%d", &containerPort)
		return hostPort, containerPort, err
	} else if len(parts) == 3 {
		var hostPort, containerPort int
		_, err := fmt.Sscanf(parts[1], "%d", &hostPort)
		if err != nil {
			return 0, 0, err
		}
		_, err = fmt.Sscanf(parts[2], "%d", &containerPort)
		return hostPort, containerPort, err
	}
	return 0, 0, fmt.Errorf("invalid port format: %s", portStr)
}

func mergeEnvironment(service map[string]interface{}, overrides map[string]string) {
	env, exists := service["environment"]
	merged := make(map[string]string)

	if exists {
		switch envVal := env.(type) {
		case map[string]interface{}:
			for k, v := range envVal {
				merged[k] = fmt.Sprintf("%v", v)
			}
		case []interface{}:
			for _, item := range envVal {
				if itemStr, ok := item.(string); ok {
					parts := strings.SplitN(itemStr, "=", 2)
					if len(parts) == 2 {
						merged[parts[0]] = parts[1]
					} else if len(parts) == 1 {
						merged[parts[0]] = ""
					}
				}
			}
		case map[interface{}]interface{}:
			for k, v := range envVal {
				merged[fmt.Sprintf("%v", k)] = fmt.Sprintf("%v", v)
			}
		}
	}

	for k, v := range overrides {
		if k != "" {
			merged[k] = v
		}
	}

	service["environment"] = merged
}

func startServiceTunnel(serviceName string, domainMode string, customDomain string, hostPort int, sessionHash string, reuseTunnel bool, oldTunnelToken string, oldTunnelID string) (url string, pid int, token string, tunnelID string, err error) {
	if domainMode == "custom" {
		if customDomain == "" {
			return "", 0, "", "", errors.New("custom domain is required for custom domain mode")
		}
		targetURL := customDomain
		if !strings.HasPrefix(targetURL, "http") {
			targetURL = "https://" + targetURL
		}
		hostname := strings.TrimPrefix(strings.TrimPrefix(targetURL, "https://"), "http://")

		accountID := getSanitizedEnv("CLOUDFLARE_ACCOUNT_ID")
		zoneID := getSanitizedEnv("CLOUDFLARE_ZONE_ID")
		apiToken := getSanitizedEnv("CLOUDFLARE_API_TOKEN")

		activeTunnelToken := oldTunnelToken
		activeTunnelID := oldTunnelID

		if !reuseTunnel || activeTunnelToken == "" {
			if accountID != "" && zoneID != "" && apiToken != "" {
				log.Printf("[Docker Go Deploy] Auto-configuring Cloudflare Tunnel for service %s...", serviceName)
				tSecret := generateHash() + generateHash() // 32 bytes hex
				tSecretBase64 := base64.StdEncoding.EncodeToString([]byte(tSecret))
				cleanSvcName := regexp.MustCompile(`[^a-zA-Z0-9_-]`).ReplaceAllString(serviceName, "_")
				tunnelName := fmt.Sprintf("tunnel-comp-%s-%s-%s", cleanSvcName, sessionHash, generateHash())

				// 1. Create Tunnel
				tBody, _ := json.Marshal(map[string]string{
					"name":          tunnelName,
					"tunnel_secret": tSecretBase64,
				})
				cReq, _ := http.NewRequest("POST", fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel", accountID), bytes.NewBuffer(tBody))
				cReq.Header.Set("Authorization", "Bearer "+apiToken)
				cReq.Header.Set("Content-Type", "application/json")
				if cResp, err := http.DefaultClient.Do(cReq); err == nil {
					defer cResp.Body.Close()
					var tunnelRes map[string]interface{}
					json.NewDecoder(cResp.Body).Decode(&tunnelRes)
					if result, _ := tunnelRes["result"].(map[string]interface{}); result != nil {
						activeTunnelID, _ = result["id"].(string)
					}
				}

				if activeTunnelID != "" {
					// 2. Configure Ingress Rules
					ingressBody, _ := json.Marshal(map[string]interface{}{
						"config": map[string]interface{}{
							"ingress": []map[string]interface{}{
								{"hostname": hostname, "service": fmt.Sprintf("http://localhost:%d", hostPort)},
								{"service": "http_status:404"},
							},
						},
					})
					cfReq, _ := http.NewRequest("PUT", fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, activeTunnelID), bytes.NewBuffer(ingressBody))
					cfReq.Header.Set("Authorization", "Bearer "+apiToken)
					cfReq.Header.Set("Content-Type", "application/json")
					if cfResp, err := http.DefaultClient.Do(cfReq); err == nil {
						cfResp.Body.Close()
					}

					// 3. Create or Update DNS CNAME Mapping
					var dnsRecordID = ""
					dnsListUrl := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records?name=%s&type=CNAME", zoneID, hostname)
					dnsListReq, _ := http.NewRequest("GET", dnsListUrl, nil)
					dnsListReq.Header.Set("Authorization", "Bearer "+apiToken)
					dnsListReq.Header.Set("Content-Type", "application/json")
					if dnsListResp, err := http.DefaultClient.Do(dnsListReq); err == nil {
						defer dnsListResp.Body.Close()
						var dnsList map[string]interface{}
						json.NewDecoder(dnsListResp.Body).Decode(&dnsList)
						if success, _ := dnsList["success"].(bool); success {
							results, _ := dnsList["result"].([]interface{})
							if len(results) > 0 {
								record, _ := results[0].(map[string]interface{})
								dnsRecordID, _ = record["id"].(string)
							}
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
						"name":    hostname,
						"content": fmt.Sprintf("%s.cfargotunnel.com", activeTunnelID),
						"proxied": true,
					})
					dnsReq, _ := http.NewRequest(dnsMethod, dnsUrl, bytes.NewBuffer(dnsBody))
					dnsReq.Header.Set("Authorization", "Bearer "+apiToken)
					dnsReq.Header.Set("Content-Type", "application/json")
					if dnsResp, err := http.DefaultClient.Do(dnsReq); err == nil {
						dnsResp.Body.Close()
					}

					// Token base64
					tokenPayload := map[string]string{"a": accountID, "t": activeTunnelID, "s": tSecretBase64}
					tokenJson, _ := json.Marshal(tokenPayload)
					activeTunnelToken = base64.StdEncoding.EncodeToString(tokenJson)
				}
			}
		} else {
			if activeTunnelID == "" && activeTunnelToken != "" {
				if decodedBytes, err := base64.StdEncoding.DecodeString(activeTunnelToken); err == nil {
					var decoded map[string]interface{}
					if err := json.Unmarshal(decodedBytes, &decoded); err == nil {
						if t, ok := decoded["t"].(string); ok {
							activeTunnelID = t
						}
					}
				}
			}
		}

		if reuseTunnel && accountID != "" && apiToken != "" && activeTunnelID != "" {
			log.Printf("[Docker Go Deploy] Updating Ingress Rules for existing Cloudflare Tunnel %s to point to port %d...", activeTunnelID, hostPort)
			ingressBody, _ := json.Marshal(map[string]interface{}{
				"config": map[string]interface{}{
					"ingress": []map[string]interface{}{
						{"hostname": hostname, "service": fmt.Sprintf("http://localhost:%d", hostPort)},
						{"service": "http_status:404"},
					},
				},
			})
			cfReq, _ := http.NewRequest("PUT", fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, activeTunnelID), bytes.NewBuffer(ingressBody))
			cfReq.Header.Set("Authorization", "Bearer "+apiToken)
			cfReq.Header.Set("Content-Type", "application/json")
			if cfResp, err := http.DefaultClient.Do(cfReq); err == nil {
				cfResp.Body.Close()
			}
		}

		if activeTunnelToken != "" {
			tCmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "run", "--token", activeTunnelToken)
			if err := tCmd.Start(); err == nil {
				return targetURL, tCmd.Process.Pid, activeTunnelToken, activeTunnelID, nil
			} else {
				return "", 0, "", "", fmt.Errorf("failed to start cloudflared tunnel: %w", err)
			}
		}
		return "", 0, "", "", errors.New("failed to configure tunnel: credentials missing or tunnel creation failed")
	}

	if domainMode == "quick" {
		tCmd := exec.Command("cloudflared", "tunnel", "--url", fmt.Sprintf("http://localhost:%d", hostPort))
		stderr, err := tCmd.StderrPipe()
		if err != nil {
			return "", 0, "", "", fmt.Errorf("failed to open stderr pipe for cloudflared: %w", err)
		}

		if err := tCmd.Start(); err != nil {
			return "", 0, "", "", fmt.Errorf("failed to start cloudflared quick tunnel: %w", err)
		}

		urlChan := make(chan string, 1)
		go func() {
			scanner := bufio.NewScanner(stderr)
			re := regexp.MustCompile(`https://[-0-9a-z]*\.trycloudflare\.com`)
			for scanner.Scan() {
				line := scanner.Text()
				if match := re.FindString(line); match != "" {
					urlChan <- match
					break
				}
			}
		}()

		select {
		case cUrl := <-urlChan:
			return cUrl, tCmd.Process.Pid, "", "", nil
		case <-time.After(30 * time.Second):
			tCmd.Process.Kill()
			return "", 0, "", "", errors.New("cloudflare quick tunnel timed out")
		}
	}

	return "", 0, "", "", nil
}

func handleDeployCompose(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	if r.Method == "OPTIONS" {
		return
	}

	var req DeployComposeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	// 1. Verify Docker is running
	if err := exec.Command("docker", "--version").Run(); err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Docker is not running on the host system."})
		return
	}

	hash := req.SessionID
	if hash == "" {
		hash = generateHash()
	} else {
		hash = strings.TrimPrefix(hash, "compose-")
	}
	sessionID := "compose-" + hash

	// Clean up old instance first if updating
	sessionsMu.Lock()
	oldSess, exists := sessions[sessionID]
	sessionsMu.Unlock()

	if exists {
		log.Printf("[Compose Go Deploy] Stopping old compose stack %s...", oldSess.Metadata.ComposeFile)
		_ = exec.Command("docker", "compose", "-f", oldSess.Metadata.ComposeFile, "down").Run()
		_ = exec.Command("docker-compose", "-f", oldSess.Metadata.ComposeFile, "down").Run()

		for _, svc := range oldSess.Metadata.Services {
			svcMeta := SessionMetadata{
				TunnelPid:    svc.TunnelPid,
				TunnelID:     svc.TunnelID,
				CustomDomain: svc.CustomDomain,
			}
			cleanupCloudflareResources(svcMeta)
		}
	}

	root := findWorkspaceRoot()
	stackDir := filepath.Join(root, "stacks", "compose-"+hash)
	if err := os.MkdirAll(stackDir, 0755); err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to create stack directory: " + err.Error()})
		return
	}
	composeFilePath := filepath.Join(stackDir, "docker-compose.yml")

	// 2. Parse Compose YAML to modify env & ports dynamically
	var composeMap map[string]interface{}
	if err := yaml.Unmarshal([]byte(req.YAML), &composeMap); err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to parse compose YAML: " + err.Error()})
		return
	}

	servicesMap, ok := composeMap["services"].(map[string]interface{})
	if !ok || len(servicesMap) == 0 {
		json.NewEncoder(w).Encode(map[string]string{"error": "No services defined in compose file"})
		return
	}

	servicePorts := make(map[string]int)

	for svcName, svcVal := range servicesMap {
		service, ok := svcVal.(map[string]interface{})
		if !ok {
			continue
		}

		setting := req.ServiceSettings[svcName]

		// Merge environment
		mergeEnvironment(service, setting.Env)

		// Parse/adjust ports
		ports, exists := service["ports"]
		var hostPort, containerPort int
		var foundPort = false

		if exists {
			if portList, ok := ports.([]interface{}); ok && len(portList) > 0 {
				if firstPort, ok := portList[0].(string); ok {
					h, c, err := parsePorts(firstPort)
					if err == nil {
						hostPort = h
						containerPort = c
						foundPort = true
					}
				} else if firstPortNum, ok := portList[0].(int); ok {
					hostPort = firstPortNum
					containerPort = firstPortNum
					foundPort = true
				}
			}
		}

		if setting.DomainMode == "quick" || setting.DomainMode == "custom" {
			if foundPort {
				if hostPort == 0 {
					nextPortMu.Lock()
					hostPort = nextPort
					nextPort++
					nextPortMu.Unlock()
					service["ports"] = []interface{}{fmt.Sprintf("%d:%d", hostPort, containerPort)}
				}
			} else {
				containerPort = 80
				nextPortMu.Lock()
				hostPort = nextPort
				nextPort++
				nextPortMu.Unlock()
				service["ports"] = []interface{}{fmt.Sprintf("%d:%d", hostPort, containerPort)}
			}
			servicePorts[svcName] = hostPort
		}
	}

	// Write modified compose back to file
	modifiedYaml, err := yaml.Marshal(composeMap)
	if err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to marshal modified compose: " + err.Error()})
		return
	}

	if err := os.WriteFile(composeFilePath, modifiedYaml, 0644); err != nil {
		json.NewEncoder(w).Encode(map[string]string{"error": "Failed to write docker-compose.yml: " + err.Error()})
		return
	}

	// Run docker compose up -d
	log.Printf("[Compose Go Deploy] Starting stack in %s...", stackDir)
	runCmd := func(name string, args ...string) error {
		cmd := exec.Command(name, args...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%s failed: %w (stderr: %s)", name, err, stderr.String())
		}
		return nil
	}

	err = runCmd("docker", "compose", "-f", composeFilePath, "up", "-d")
	if err != nil {
		log.Printf("[Compose Go Deploy] 'docker compose' failed, trying 'docker-compose': %v", err)
		err = runCmd("docker-compose", "-f", composeFilePath, "up", "-d")
		if err != nil {
			json.NewEncoder(w).Encode(map[string]string{"error": "Docker Compose failed to start stack: " + err.Error()})
			return
		}
	}

	// 3. Configure Tunnels for routed services
	serviceSessionMetas := make(map[string]ServiceSessionMetadata)
	var mainURL = ""

	for svcName, setting := range req.ServiceSettings {
		if setting.DomainMode == "quick" || setting.DomainMode == "custom" {
			hostPort := servicePorts[svcName]
			if hostPort <= 0 {
				continue
			}

			reuseTunnel := false
			oldToken := ""
			oldTID := ""
			if exists {
				if oldSvc, ok := oldSess.Metadata.Services[svcName]; ok {
					if oldSvc.DomainMode == setting.DomainMode && oldSvc.CustomDomain == setting.CustomDomain {
						reuseTunnel = true
						oldToken = oldSvc.TunnelToken
						oldTID = oldSvc.TunnelID
					}
				}
			}

			tUrl, tPid, tToken, tID, err := startServiceTunnel(svcName, setting.DomainMode, setting.CustomDomain, hostPort, hash, reuseTunnel, oldToken, oldTID)
			if err != nil {
				log.Printf("[Compose Go Deploy] Failed to start tunnel for service %s: %v", svcName, err)
				continue
			}

			if mainURL == "" {
				mainURL = tUrl
			}

			serviceSessionMetas[svcName] = ServiceSessionMetadata{
				ServiceName:    svcName,
				Port:           80,
				HostPort:       hostPort,
				DomainMode:     setting.DomainMode,
				CustomDomain:   setting.CustomDomain,
				CloudflaredURL: tUrl,
				TunnelPid:      tPid,
				TunnelToken:    tToken,
				TunnelID:       tID,
			}
		}
	}

	if mainURL == "" {
		mainURL = "http://localhost"
	}

	sess := Session{
		ID:        sessionID,
		Type:      "docker-compose",
		URL:       mainURL,
		StartedAt: time.Now(),
		Metadata: SessionMetadata{
			ComposeFile: composeFilePath,
			Services:    serviceSessionMetas,
		},
	}

	sessionsMu.Lock()
	sessions[sessionID] = sess
	sessionsMu.Unlock()
	saveSessions()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"url":       mainURL,
		"services":  serviceSessionMetas,
		"success":   true,
		"sessionId": sessionID,
	})
}
