package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
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
)

// Session structure matching TS backend
type SessionMetadata struct {
	Port           int               `json:"port,omitempty"`
	HostPort       int               `json:"hostPort,omitempty"`
	ContainerName  string            `json:"containerName,omitempty"`
	TargetURL      string            `json:"targetUrl,omitempty"`
	Image          string            `json:"image,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	DomainMode     string            `json:"domainMode,omitempty"`
	CustomDomain   string            `json:"customDomain,omitempty"`
	TunnelPid      int               `json:"tunnelPid,omitempty"`
	CloudflaredURL string            `json:"cloudflaredUrl,omitempty"`
	WebhookSecret  string            `json:"webhookSecret,omitempty"`
	TunnelToken    string            `json:"tunnelToken,omitempty"`
	TunnelID       string            `json:"tunnelId,omitempty"`
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
		if s.Type == "docker-container" {
			toRestore = append(toRestore, s)
		}
	}
	sessionsMu.RUnlock()

	for _, s := range toRestore {
		go func(sess Session) {
			meta := sess.Metadata
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
	if exists {
		webhookSecret = oldSess.Metadata.WebhookSecret
		log.Printf("[Docker Go Start] Stopping old container %s...", oldSess.Metadata.ContainerName)
		_ = exec.Command("docker", "stop", oldSess.Metadata.ContainerName).Run()
		cleanupCloudflareResources(oldSess.Metadata)
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
	var tunnelToken = req.TunnelToken
	var tunnelID = ""
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

		if tunnelToken == "" && accountID != "" && zoneID != "" && apiToken != "" {
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
					tunnelID, _ = result["id"].(string)
				}
			}

			if tunnelID != "" {
				// 2. Configure Ingress Rules
				ingressBody, _ := json.Marshal(map[string]interface{}{
					"config": map[string]interface{}{
						"ingress": []map[string]interface{}{
							{"hostname": hostname, "service": fmt.Sprintf("http://localhost:%d", hostPort)},
							{"service": "http_status:404"},
						},
					},
				})
				cfReq, _ := http.NewRequest("PUT", fmt.Sprintf("https://api.cloudflare.com/client/v4/accounts/%s/cfd_tunnel/%s/configurations", accountID, tunnelID), bytes.NewBuffer(ingressBody))
				cfReq.Header.Set("Authorization", "Bearer "+apiToken)
				cfReq.Header.Set("Content-Type", "application/json")
				if cfResp, err := http.DefaultClient.Do(cfReq); err == nil {
					cfResp.Body.Close()
				}

				// 3. DNS CNAME Mapping
				dnsBody, _ := json.Marshal(map[string]interface{}{
					"type":    "CNAME",
					"name":    hostname,
					"content": fmt.Sprintf("%s.cfargotunnel.com", tunnelID),
					"proxied": true,
				})
				dnsUrl := fmt.Sprintf("https://api.cloudflare.com/client/v4/zones/%s/dns_records", zoneID)
				dnsReq, _ := http.NewRequest("POST", dnsUrl, bytes.NewBuffer(dnsBody))
				dnsReq.Header.Set("Authorization", "Bearer "+apiToken)
				dnsReq.Header.Set("Content-Type", "application/json")
				if dnsResp, err := http.DefaultClient.Do(dnsReq); err == nil {
					dnsResp.Body.Close()
				}

				// Token base64
				tokenPayload := map[string]string{"a": accountID, "t": tunnelID, "s": tSecretBase64}
				tokenJson, _ := json.Marshal(tokenPayload)
				tunnelToken = base64.StdEncoding.EncodeToString(tokenJson)
			}
		}

		if tunnelToken != "" {
			tCmd := exec.Command("cloudflared", "tunnel", "--no-autoupdate", "run", "--token", tunnelToken)
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
				TunnelToken:    tunnelToken,
				TunnelID:       tunnelID,
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
	log.Printf("[Docker Go Stop] Stopping container: %s", meta.ContainerName)
	_ = exec.Command("docker", "stop", meta.ContainerName).Run()
	cleanupCloudflareResources(meta)

	saveSessions()

	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"message": "Docker container stopped and resources cleaned up.",
	})
}
