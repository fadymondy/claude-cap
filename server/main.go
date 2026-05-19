package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxUploadSize = 50 << 20 // 50 MiB
	storeDir      = "/data/screenshots"
)

type Meta struct {
	URL         string                 `json:"url,omitempty"`
	Title       string                 `json:"title,omitempty"`
	Viewport    string                 `json:"viewport,omitempty"`
	UserAgent   string                 `json:"user_agent,omitempty"`
	When        string                 `json:"when,omitempty"`
	Note        string                 `json:"note,omitempty"`
	Region      interface{}            `json:"region,omitempty"`
	NetworkReqs []map[string]any       `json:"network_requests,omitempty"`
	Console     []map[string]any       `json:"console,omitempty"`
	Extras      map[string]interface{} `json:"extras,omitempty"`
}

type ListItem struct {
	ID   string `json:"id"`
	URL  string `json:"url"`
	Size int64  `json:"size"`
	When string `json:"when"`
	Meta *Meta  `json:"meta,omitempty"`
}

// Command system: MCP posts a command, server relays to extension via SSE, extension POSTs the result.

type Command struct {
	ID      string                 `json:"id"`
	Type    string                 `json:"type"` // "capture" | "navigate" | "navigate_and_capture"
	Args    map[string]interface{} `json:"args,omitempty"`
	IssuedAt time.Time             `json:"-"`
}

type CommandResult struct {
	ID      string                 `json:"id"`
	Ok      bool                   `json:"ok"`
	Error   string                 `json:"error,omitempty"`
	Payload map[string]interface{} `json:"payload,omitempty"` // typically { url, meta_url, sha256 }
}

var (
	commandsMu    sync.Mutex
	commandsResult = make(map[string]chan *CommandResult)
	sseClientsMu  sync.Mutex
	sseClients    = make(map[chan []byte]bool) // each client = a chan of bytes to write
)

func broadcastSSE(payload []byte) {
	sseClientsMu.Lock()
	defer sseClientsMu.Unlock()
	for ch := range sseClients {
		select {
		case ch <- payload:
		default:
			// slow client; drop
		}
	}
}

func main() {
	token := os.Getenv("CAP_TOKEN")
	if token == "" {
		log.Fatal("CAP_TOKEN env required")
	}
	loginPassword := os.Getenv("CAP_LOGIN_PASSWORD")
	publicBase := os.Getenv("CAP_PUBLIC_BASE")
	if publicBase == "" {
		publicBase = "https://cap.local"
	}
	if err := os.MkdirAll(storeDir, 0o755); err != nil {
		log.Fatalf("mkdir: %v", err)
	}

	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})

	// Exchange a friendly password for the long Bearer token. Used by the extension manager.
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		// Accept either the configured login password, or the raw token itself.
		ok := false
		if loginPassword != "" && body.Password == loginPassword {
			ok = true
		}
		if body.Password == token {
			ok = true
		}
		if !ok {
			http.Error(w, `{"error":"invalid password"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"token": token})
	})

	// Delete a screenshot (and its sidecar metadata).
	mux.HandleFunc("/delete/", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodDelete && r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/delete/")
		if name == "" || strings.Contains(name, "/") || strings.Contains(name, "..") {
			http.Error(w, "bad name", http.StatusBadRequest)
			return
		}
		imgPath := filepath.Join(storeDir, name)
		id := strings.TrimSuffix(name, filepath.Ext(name))
		metaPath := filepath.Join(storeDir, id+".json")
		removedImg := os.Remove(imgPath) == nil
		os.Remove(metaPath)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"deleted": removedImg})
	})

	mux.HandleFunc("/upload", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
		if err := r.ParseMultipartForm(maxUploadSize); err != nil {
			http.Error(w, "file too large or malformed", http.StatusBadRequest)
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, "missing 'file' field", http.StatusBadRequest)
			return
		}
		defer file.Close()

		ext := strings.ToLower(filepath.Ext(header.Filename))
		if ext == "" {
			ext = ".png"
		}
		if ext != ".png" && ext != ".jpg" && ext != ".jpeg" && ext != ".gif" && ext != ".webp" {
			http.Error(w, "unsupported file type", http.StatusUnsupportedMediaType)
			return
		}

		id, err := randomID()
		if err != nil {
			http.Error(w, "id gen failed", http.StatusInternalServerError)
			return
		}
		name := id + ext
		dst, err := os.Create(filepath.Join(storeDir, name))
		if err != nil {
			http.Error(w, "store failed", http.StatusInternalServerError)
			return
		}
		hasher := sha256.New()
		if _, err := io.Copy(io.MultiWriter(dst, hasher), file); err != nil {
			dst.Close()
			os.Remove(dst.Name())
			http.Error(w, "write failed", http.StatusInternalServerError)
			return
		}
		dst.Close()

		metaJSON := r.FormValue("meta")
		if metaJSON != "" {
			var m Meta
			if err := json.Unmarshal([]byte(metaJSON), &m); err == nil {
				if m.When == "" {
					m.When = time.Now().UTC().Format(time.RFC3339)
				}
				b, _ := json.MarshalIndent(m, "", "  ")
				os.WriteFile(filepath.Join(storeDir, id+".json"), b, 0o644)
			}
		}

		resp := map[string]string{
			"url":      publicBase + "/s/" + name,
			"meta_url": publicBase + "/m/" + id + ".json",
			"sha256":   hex.EncodeToString(hasher.Sum(nil)),
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		log.Printf("uploaded %s (%d bytes, meta=%t)", name, header.Size, metaJSON != "")
	})

	mux.HandleFunc("/list", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		limit := 10
		if n, _ := strconv.Atoi(r.URL.Query().Get("limit")); n > 0 && n <= 100 {
			limit = n
		}

		entries, err := os.ReadDir(storeDir)
		if err != nil {
			http.Error(w, "scan failed", http.StatusInternalServerError)
			return
		}
		type fe struct {
			name  string
			mtime time.Time
			size  int64
		}
		var imgs []fe
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			lo := strings.ToLower(name)
			if !(strings.HasSuffix(lo, ".png") || strings.HasSuffix(lo, ".jpg") ||
				strings.HasSuffix(lo, ".jpeg") || strings.HasSuffix(lo, ".gif") ||
				strings.HasSuffix(lo, ".webp")) {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			imgs = append(imgs, fe{name: name, mtime: info.ModTime(), size: info.Size()})
		}
		sort.Slice(imgs, func(i, j int) bool { return imgs[i].mtime.After(imgs[j].mtime) })
		if len(imgs) > limit {
			imgs = imgs[:limit]
		}

		items := make([]ListItem, 0, len(imgs))
		for _, it := range imgs {
			id := strings.TrimSuffix(it.name, filepath.Ext(it.name))
			item := ListItem{
				ID:   it.name,
				URL:  publicBase + "/s/" + it.name,
				Size: it.size,
				When: it.mtime.UTC().Format(time.RFC3339),
			}
			if b, err := os.ReadFile(filepath.Join(storeDir, id+".json")); err == nil {
				var m Meta
				if json.Unmarshal(b, &m) == nil {
					item.Meta = &m
				}
			}
			items = append(items, item)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"items": items, "count": len(items)})
	})

	// --- Command channel: MCP <-> extension via SSE ---

	// Extension subscribes here. Auth via ?token=... (EventSource can't set headers).
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("token") != token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming not supported", http.StatusInternalServerError)
			return
		}

		ch := make(chan []byte, 16)
		sseClientsMu.Lock()
		sseClients[ch] = true
		sseClientsMu.Unlock()
		defer func() {
			sseClientsMu.Lock()
			delete(sseClients, ch)
			sseClientsMu.Unlock()
			close(ch)
		}()

		// Initial hello.
		fmt.Fprintf(w, "event: hello\ndata: {}\n\n")
		flusher.Flush()

		ping := time.NewTicker(15 * time.Second)
		defer ping.Stop()

		for {
			select {
			case <-r.Context().Done():
				return
			case <-ping.C:
				fmt.Fprintf(w, "event: ping\ndata: {}\n\n")
				flusher.Flush()
			case msg := <-ch:
				fmt.Fprintf(w, "event: command\ndata: %s\n\n", msg)
				flusher.Flush()
			}
		}
	})

	// MCP enqueues a command and waits for the extension to respond.
	mux.HandleFunc("/command", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			Type      string                 `json:"type"`
			Args      map[string]interface{} `json:"args"`
			TimeoutMs int                    `json:"timeout_ms"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		if body.Type == "" {
			http.Error(w, "type required", http.StatusBadRequest)
			return
		}
		timeout := time.Duration(body.TimeoutMs) * time.Millisecond
		if timeout <= 0 || timeout > 90*time.Second {
			timeout = 30 * time.Second
		}

		id, _ := randomID()
		cmd := Command{ID: id, Type: body.Type, Args: body.Args, IssuedAt: time.Now()}
		buf, _ := json.Marshal(cmd)

		resultCh := make(chan *CommandResult, 1)
		commandsMu.Lock()
		commandsResult[id] = resultCh
		commandsMu.Unlock()
		defer func() {
			commandsMu.Lock()
			delete(commandsResult, id)
			commandsMu.Unlock()
		}()

		// Check if any extension is connected before dispatching.
		sseClientsMu.Lock()
		n := len(sseClients)
		sseClientsMu.Unlock()
		if n == 0 {
			http.Error(w, `{"error":"no extension connected"}`, http.StatusServiceUnavailable)
			return
		}

		broadcastSSE(buf)

		select {
		case res := <-resultCh:
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(res)
		case <-time.After(timeout):
			http.Error(w, `{"error":"timeout"}`, http.StatusGatewayTimeout)
		}
	})

	// Extension posts the result here.
	mux.HandleFunc("/command/result", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var res CommandResult
		if err := json.NewDecoder(r.Body).Decode(&res); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		commandsMu.Lock()
		ch, ok := commandsResult[res.ID]
		commandsMu.Unlock()
		if !ok {
			http.Error(w, `{"error":"unknown command id"}`, http.StatusNotFound)
			return
		}
		ch <- &res
		w.Write([]byte(`{"ok":true}`))
	})

	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		sseClientsMu.Lock()
		clients := len(sseClients)
		sseClientsMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"extension_connected": clients > 0,
			"extension_count":     clients,
		})
	})

	mux.Handle("/s/", corsMiddleware(http.StripPrefix("/s/", http.FileServer(http.Dir(storeDir)))))
	mux.Handle("/m/", corsMiddleware(http.StripPrefix("/m/", http.FileServer(http.Dir(storeDir)))))

	srv := &http.Server{
		Addr:              ":8585",
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      0, // SSE
	}
	log.Printf("cap-server listening on :8585, store=%s, public=%s", storeDir, publicBase)
	log.Fatal(srv.ListenAndServe())
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
}

func corsMiddleware(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			return
		}
		h.ServeHTTP(w, r)
	})
}

func randomID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d-%s", time.Now().Unix(), hex.EncodeToString(b)), nil
}
