package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/guoxudong/horcrux/internal/engine"
	"github.com/guoxudong/horcrux/internal/vault"
)

type Handler struct {
	vault              *vault.Vault
	hub                *Hub
	syncerFactory      func(ctx context.Context, progress chan<- engine.Progress) syncerRunner
	activeTaskCancels  sync.Map
	registryReposCache sync.Map
	registryTagsCache  sync.Map
	pipesMu            sync.Mutex
}

type syncerRunner interface {
	SyncManifestList(opts engine.SyncOptions) error
}

func NewHandler(v *vault.Vault, hub *Hub) *Handler {
	return NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return engine.NewSyncerWithContext(ctx, progress)
	})
}

func NewHandlerWithSyncerFactory(v *vault.Vault, hub *Hub, factory func(ctx context.Context, progress chan<- engine.Progress) syncerRunner) *Handler {
	if factory == nil {
		factory = func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
			return engine.NewSyncerWithContext(ctx, progress)
		}
	}
	return &Handler{
		vault:         v,
		hub:           hub,
		syncerFactory: factory,
	}
}

func (h *Handler) Health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (h *Handler) ListCredentials(c *gin.Context) {
	creds, err := h.vault.LoadCredentials()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 自动修复受损的 ID（包含不可见字符的 ID）
	needsSave := false
	for i := range creds {
		if isWeirdID(creds[i].ID) {
			creds[i].ID = fmt.Sprintf("cred_%d_%d", time.Now().Unix(), i)
			needsSave = true
		}
	}

	if needsSave {
		h.vault.SaveCredentials(creds)
	}

	// Don't return passwords
	for i := range creds {
		creds[i].Password = "********"
	}
	c.JSON(http.StatusOK, creds)
}

// isWeirdID 检查 ID 是否包含不可见字符或非预期字符
func isWeirdID(id string) bool {
	if id == "" {
		return true
	}
	for _, r := range id {
		if r < 32 || r > 126 {
			return true
		}
	}
	return false
}

func (h *Handler) AddCredential(c *gin.Context) {
	var cred vault.Credential
	if err := c.ShouldBindJSON(&cred); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	creds, err := h.vault.LoadCredentials()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// 使用纳秒级时间戳生成唯一 ID，避免删除后 ID 碰撞
	if cred.ID == "" {
		cred.ID = fmt.Sprintf("cred_%d", time.Now().UnixNano())
	}

	creds = append(creds, cred)
	if err := h.vault.SaveCredentials(creds); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, gin.H{"status": "created", "id": cred.ID})
}

func (h *Handler) UpdateCredential(c *gin.Context) {
	id := c.Param("id")
	var updatedCred vault.Credential
	if err := c.ShouldBindJSON(&updatedCred); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	creds, err := h.vault.LoadCredentials()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	found := false
	for i, cred := range creds {
		if cred.ID == id {
			// Update fields (keep original password if not provided or masked)
			if updatedCred.Password == "********" || updatedCred.Password == "" {
				updatedCred.Password = cred.Password
			}
			updatedCred.ID = id // Ensure ID doesn't change
			creds[i] = updatedCred
			found = true
			break
		}
	}

	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "credential not found"})
		return
	}

	if err := h.vault.SaveCredentials(creds); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "updated"})
}

func (h *Handler) DeleteCredential(c *gin.Context) {
	id := c.Param("id")

	creds, err := h.vault.LoadCredentials()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	newCreds := []vault.Credential{}
	found := false
	for _, cred := range creds {
		if cred.ID == id {
			found = true
			continue
		}
		newCreds = append(newCreds, cred)
	}

	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "credential not found"})
		return
	}

	if err := h.vault.SaveCredentials(newCreds); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

func (h *Handler) VerifyCredential(c *gin.Context) {
	id := c.Param("id")
	creds, err := h.vault.LoadCredentials()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var target vault.Credential
	found := false
	for _, cred := range creds {
		if cred.ID == id {
			target = cred
			found = true
			break
		}
	}

	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "credential not found"})
		return
	}

	// 尝试验证凭证
	// 使用 nil 作为 progress channel，因为在 VerifyCredential 中我们不需要实时进度日志
	// 且不需要启动额外的 goroutine 来消费它，防止阻塞
	syncer := engine.NewSyncer(nil)

	// 这里使用 syncer 的内部方法或者简单的 registry ping
	err = syncer.VerifyAuth(target.Registry, &target)
	if err != nil {
		fmt.Printf("[API] Verification failed for ID %s: %v\n", id, err)
		c.JSON(http.StatusUnauthorized, gin.H{"status": "error", "message": err.Error()})
		return
	}

	fmt.Printf("[API] Verification success for ID %s\n", id)
	c.JSON(http.StatusOK, gin.H{"status": "success"})
}

type cachedStringList struct {
	ExpiresAt time.Time
	Values    []string
}

func (h *Handler) getCachedStringList(cache *sync.Map, key string) ([]string, bool) {
	raw, ok := cache.Load(key)
	if !ok {
		return nil, false
	}
	entry, ok := raw.(cachedStringList)
	if !ok {
		cache.Delete(key)
		return nil, false
	}
	if time.Now().After(entry.ExpiresAt) {
		cache.Delete(key)
		return nil, false
	}
	return entry.Values, true
}

func (h *Handler) setCachedStringList(cache *sync.Map, key string, values []string, ttl time.Duration) {
	if ttl <= 0 {
		return
	}
	cache.Store(key, cachedStringList{ExpiresAt: time.Now().Add(ttl), Values: values})
}

type bearerChallenge struct {
	Realm   string
	Service string
	Scope   string
}

func parseBearerChallenge(header string) bearerChallenge {
	out := bearerChallenge{}
	header = strings.TrimSpace(header)
	if header == "" || !strings.HasPrefix(strings.ToLower(header), "bearer ") {
		return out
	}
	rest := strings.TrimSpace(header[len("Bearer "):])
	parts := strings.Split(rest, ",")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		k := strings.TrimSpace(kv[0])
		v := strings.Trim(strings.TrimSpace(kv[1]), `"`)
		switch strings.ToLower(k) {
		case "realm":
			out.Realm = v
		case "service":
			out.Service = v
		case "scope":
			out.Scope = v
		}
	}
	return out
}

func normalizeRegistryBase(registry string) string {
	registry = strings.TrimSpace(registry)
	if registry == "" || registry == "docker.io" {
		registry = "registry-1.docker.io"
	}
	if strings.Contains(registry, "://") {
		return registry
	}
	return "https://" + registry
}

func splitRegistryAndRepo(repo string) (string, string) {
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return "", ""
	}
	if idx := strings.Index(repo, "@"); idx >= 0 {
		repo = repo[:idx]
	}
	lastSlash := strings.LastIndex(repo, "/")
	lastColon := strings.LastIndex(repo, ":")
	if lastColon > lastSlash {
		repo = repo[:lastColon]
	}

	firstSlash := strings.Index(repo, "/")
	if firstSlash <= 0 {
		return "", repo
	}
	firstPart := repo[:firstSlash]
	if strings.Contains(firstPart, ".") || strings.Contains(firstPart, ":") || firstPart == "localhost" {
		return firstPart, repo[firstSlash+1:]
	}
	return "", repo
}

func newRegistryHTTPClient() *http.Client {
	return &http.Client{Timeout: 20 * time.Second}
}

func (h *Handler) registryGet(ctx context.Context, baseURL string, path string, cred *vault.Credential) ([]byte, http.Header, int, error) {
	u := strings.TrimRight(baseURL, "/") + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "horcrux/registry-query")
	if cred != nil && cred.Username != "" {
		req.SetBasicAuth(cred.Username, cred.Password)
	}
	client := newRegistryHTTPClient()
	resp, err := client.Do(req)
	if err != nil {
		select {
		case <-ctx.Done():
			return nil, nil, 0, err
		case <-time.After(180 * time.Millisecond):
		}
		resp, err = client.Do(req)
		if err != nil {
			return nil, nil, 0, err
		}
	}
	defer resp.Body.Close()
	body, readErr := ioReadAllLimit(resp.Body, 8<<20)
	if readErr != nil {
		return nil, resp.Header, resp.StatusCode, readErr
	}
	if resp.StatusCode == http.StatusUnauthorized {
		ch := parseBearerChallenge(resp.Header.Get("Www-Authenticate"))
		if ch.Realm != "" {
			token, tokenErr := fetchBearerToken(ctx, ch, cred)
			if tokenErr != nil {
				return body, resp.Header, resp.StatusCode, tokenErr
			}
			req2, err2 := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
			if err2 != nil {
				return body, resp.Header, resp.StatusCode, err2
			}
			req2.Header.Set("Accept", "application/json")
			req2.Header.Set("User-Agent", "horcrux/registry-query")
			req2.Header.Set("Authorization", "Bearer "+token)
			resp2, err2 := client.Do(req2)
			if err2 != nil {
				return body, resp.Header, resp.StatusCode, err2
			}
			defer resp2.Body.Close()
			body2, readErr2 := ioReadAllLimit(resp2.Body, 8<<20)
			if readErr2 != nil {
				return nil, resp2.Header, resp2.StatusCode, readErr2
			}
			if resp2.StatusCode >= 400 {
				return body2, resp2.Header, resp2.StatusCode, fmt.Errorf("registry request failed: %s", resp2.Status)
			}
			return body2, resp2.Header, resp2.StatusCode, nil
		}
	}
	if resp.StatusCode >= 400 {
		return body, resp.Header, resp.StatusCode, fmt.Errorf("registry request failed: %s", resp.Status)
	}
	return body, resp.Header, resp.StatusCode, nil
}

func fetchBearerToken(ctx context.Context, ch bearerChallenge, cred *vault.Credential) (string, error) {
	if ch.Realm == "" {
		return "", errors.New("missing bearer realm")
	}
	u, err := url.Parse(ch.Realm)
	if err != nil {
		return "", err
	}
	q := u.Query()
	if ch.Service != "" {
		q.Set("service", ch.Service)
	}
	if ch.Scope != "" {
		q.Set("scope", ch.Scope)
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "horcrux/registry-query")
	if cred != nil && cred.Username != "" {
		req.SetBasicAuth(cred.Username, cred.Password)
	}

	resp, err := newRegistryHTTPClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, readErr := ioReadAllLimit(resp.Body, 4<<20)
	if readErr != nil {
		return "", readErr
	}
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("token request failed: %s", resp.Status)
	}
	var out struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.Token != "" {
		return out.Token, nil
	}
	if out.AccessToken != "" {
		return out.AccessToken, nil
	}
	return "", errors.New("token missing in response")
}

func ioReadAllLimit(r io.Reader, limit int64) ([]byte, error) {
	if limit <= 0 {
		limit = 1 << 20
	}
	lr := &io.LimitedReader{R: r, N: limit}
	return io.ReadAll(lr)
}

type registryErrorItem struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func extractRegistryErrorDetail(body []byte) string {
	b := bytesToSafeText(body, 900)
	if b == "" {
		return ""
	}
	var parsed struct {
		Errors []registryErrorItem `json:"errors"`
		Error  string              `json:"error"`
	}
	if err := json.Unmarshal([]byte(b), &parsed); err == nil {
		if len(parsed.Errors) > 0 {
			parts := make([]string, 0, len(parsed.Errors))
			for _, it := range parsed.Errors {
				msg := strings.TrimSpace(it.Message)
				code := strings.TrimSpace(it.Code)
				if msg == "" && code == "" {
					continue
				}
				if code != "" && msg != "" {
					parts = append(parts, code+": "+msg)
					continue
				}
				if msg != "" {
					parts = append(parts, msg)
					continue
				}
				parts = append(parts, code)
			}
			return strings.Join(parts, " | ")
		}
		if strings.TrimSpace(parsed.Error) != "" {
			return strings.TrimSpace(parsed.Error)
		}
	}
	return strings.TrimSpace(b)
}

func bytesToSafeText(body []byte, maxLen int) string {
	if len(body) == 0 || maxLen <= 0 {
		return ""
	}
	s := strings.TrimSpace(string(body))
	if s == "" {
		return ""
	}
	s = strings.ReplaceAll(s, "\r", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.Join(strings.Fields(s), " ")
	if maxLen > 0 && len(s) > maxLen {
		return s[:maxLen] + "…"
	}
	return s
}

func (h *Handler) findCredentialByID(id string) (*vault.Credential, error) {
	if strings.TrimSpace(id) == "" {
		return nil, nil
	}
	creds, err := h.vault.LoadCredentials()
	if err != nil {
		return nil, err
	}
	for _, cred := range creds {
		if cred.ID == id {
			c := cred
			return &c, nil
		}
	}
	return nil, nil
}

func (h *Handler) ListRegistryRepositories(c *gin.Context) {
	credID := strings.TrimSpace(c.Query("cred_id"))
	registryOverride := strings.TrimSpace(c.Query("registry"))
	namespace := strings.TrimSpace(c.Query("namespace"))

	cred, err := h.findCredentialByID(credID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "vault load failed"})
		return
	}

	registry := registryOverride
	if registry == "" && cred != nil {
		registry = cred.Registry
	}
	if registry == "" {
		registry = "docker.io"
	}

	if cred != nil {
		user := strings.TrimSpace(cred.Username)
		pass := strings.TrimSpace(cred.Password)
		passMasked := cred.Password == "********"
		log.Printf("[API][registry] repositories auth_check cred_id=%s registry=%s user_len=%d pass_len=%d masked=%t", credID, registry, len(user), len(pass), passMasked)
		if user != "" && (pass == "" || passMasked) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":           "Registry_Auth 密码为空或已被脱敏，请重新保存凭证密码后再试",
				"upstream_status": 0,
			})
			return
		}
	} else {
		log.Printf("[API][registry] repositories auth_check cred_id=%s registry=%s cred_not_found=true", credID, registry)
	}

	registryHost := strings.ToLower(strings.TrimSpace(registry))
	registryHost = strings.TrimPrefix(registryHost, "https://")
	registryHost = strings.TrimPrefix(registryHost, "http://")
	registryHost = strings.TrimSuffix(registryHost, "/")
	if registryHost == "docker.io" || registryHost == "index.docker.io" || registryHost == "registry-1.docker.io" {
		ns := strings.TrimSpace(namespace)
		if ns == "" {
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error":           "Docker Hub 不支持通过 catalog 列出全部仓库，请先输入 namespace 再查询",
				"upstream_status": 0,
			})
			return
		}
		cacheKey := "repos|dockerhub|" + credID + "|" + strings.ToLower(ns)
		if values, ok := h.getCachedStringList(&h.registryReposCache, cacheKey); ok {
			log.Printf("[API][registry] dockerhub repos cache_hit cred_id=%s namespace=%s size=%d", credID, ns, len(values))
			c.JSON(http.StatusOK, gin.H{"repositories": values, "cached": true})
			return
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
		defer cancel()
		repos, statusCode, detail, listErr := dockerHubListNamespaceRepositories(ctx, ns, cred)
		if listErr != nil {
			log.Printf(
				"[API][registry] dockerhub repos error cred_id=%s namespace=%s status=%d err=%v detail=%s",
				credID,
				ns,
				statusCode,
				listErr,
				detail,
			)
			if statusCode == http.StatusNotFound {
				c.JSON(http.StatusNotFound, gin.H{"error": "namespace 不存在或无权限访问", "upstream_status": statusCode, "detail": detail})
				return
			}
			msg := "Docker Hub 镜像列表查询失败"
			if statusCode == 0 {
				msg = "Docker Hub 网络请求失败"
			} else if statusCode >= 500 {
				msg = "Docker Hub 暂时不可用"
			}
			c.JSON(http.StatusBadGateway, gin.H{"error": msg, "upstream_status": statusCode, "detail": detail})
			return
		}
		h.setCachedStringList(&h.registryReposCache, cacheKey, repos, 3*time.Minute)
		log.Printf("[API][registry] dockerhub repos ok cred_id=%s namespace=%s size=%d", credID, ns, len(repos))
		c.JSON(http.StatusOK, gin.H{"repositories": repos, "cached": false})
		return
	}

	cacheKey := "repos|" + registry + "|" + credID
	if values, ok := h.getCachedStringList(&h.registryReposCache, cacheKey); ok {
		log.Printf("[API][registry] repositories cache_hit cred_id=%s registry=%s size=%d", credID, registry, len(values))
		c.JSON(http.StatusOK, gin.H{"repositories": values, "cached": true})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
	defer cancel()

	base := normalizeRegistryBase(registry)
	repos := make([]string, 0, 256)
	last := ""
	pageSize := 200

	for {
		path := fmt.Sprintf("/v2/_catalog?n=%d", pageSize)
		if last != "" {
			path += "&last=" + url.QueryEscape(last)
		}
		body, hdr, statusCode, reqErr := h.registryGet(ctx, base, path, cred)
		if reqErr != nil {
			detail := extractRegistryErrorDetail(body)
			log.Printf(
				"[API][registry] repositories error cred_id=%s registry=%s url=%s status=%d err=%v detail=%s",
				credID,
				registry,
				strings.TrimRight(base, "/")+path,
				statusCode,
				reqErr,
				detail,
			)
			if statusCode == http.StatusNotFound {
				c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "该镜像仓库不支持 catalog 查询", "upstream_status": statusCode, "detail": detail})
				return
			}
			if statusCode == http.StatusUnauthorized {
				c.JSON(http.StatusBadGateway, gin.H{"error": "镜像仓库鉴权失败", "upstream_status": statusCode, "detail": detail})
				return
			}
			if statusCode == http.StatusForbidden {
				c.JSON(http.StatusBadGateway, gin.H{"error": "镜像仓库权限不足", "upstream_status": statusCode, "detail": detail})
				return
			}
			msg := "镜像仓库查询失败"
			if statusCode >= 500 {
				msg = "镜像仓库暂时不可用"
			}
			if statusCode == 0 {
				msg = "镜像仓库网络请求失败"
			}
			c.JSON(http.StatusBadGateway, gin.H{"error": msg, "upstream_status": statusCode, "detail": detail})
			return
		}

		var payload struct {
			Repositories []string `json:"repositories"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": "镜像仓库返回数据解析失败"})
			return
		}
		if len(payload.Repositories) == 0 {
			break
		}
		repos = append(repos, payload.Repositories...)

		link := hdr.Get("Link")
		if link == "" || len(payload.Repositories) < pageSize {
			break
		}
		last = payload.Repositories[len(payload.Repositories)-1]
	}

	sort.Strings(repos)
	h.setCachedStringList(&h.registryReposCache, cacheKey, repos, 3*time.Minute)
	log.Printf("[API][registry] repositories ok cred_id=%s registry=%s size=%d", credID, registry, len(repos))
	c.JSON(http.StatusOK, gin.H{"repositories": repos, "cached": false})
}

type dockerHubLoginResp struct {
	Token string `json:"token"`
}

type dockerHubRepoListResp struct {
	Next    string `json:"next"`
	Results []struct {
		Name string `json:"name"`
	} `json:"results"`
}

func dockerHubLogin(ctx context.Context, cred *vault.Credential) (string, int, string, error) {
	if cred == nil {
		return "", 0, "", nil
	}
	user := strings.TrimSpace(cred.Username)
	pass := strings.TrimSpace(cred.Password)
	if user == "" || pass == "" || pass == "********" {
		return "", 0, "", nil
	}

	payload, _ := json.Marshal(map[string]string{
		"username": user,
		"password": pass,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://hub.docker.com/v2/users/login/", strings.NewReader(string(payload)))
	if err != nil {
		return "", 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "horcrux/dockerhub-query")

	resp, err := newRegistryHTTPClient().Do(req)
	if err != nil {
		return "", 0, "", err
	}
	defer resp.Body.Close()
	body, readErr := ioReadAllLimit(resp.Body, 2<<20)
	if readErr != nil {
		return "", resp.StatusCode, "", readErr
	}
	if resp.StatusCode >= 400 {
		return "", resp.StatusCode, extractRegistryErrorDetail(body), fmt.Errorf("dockerhub login failed: %s", resp.Status)
	}
	var out dockerHubLoginResp
	if err := json.Unmarshal(body, &out); err != nil {
		return "", resp.StatusCode, bytesToSafeText(body, 260), err
	}
	if strings.TrimSpace(out.Token) == "" {
		return "", resp.StatusCode, bytesToSafeText(body, 260), errors.New("dockerhub login token missing")
	}
	return out.Token, resp.StatusCode, "", nil
}

func dockerHubListNamespaceRepositories(ctx context.Context, namespace string, cred *vault.Credential) ([]string, int, string, error) {
	ns := strings.Trim(strings.TrimSpace(namespace), "/")
	if ns == "" {
		return nil, http.StatusBadRequest, "", errors.New("namespace is required")
	}

	token, _, _, _ := dockerHubLogin(ctx, cred)
	pageSize := 100
	nextURL := fmt.Sprintf("https://hub.docker.com/v2/repositories/%s/?page_size=%d", url.PathEscape(ns), pageSize)

	repos := make([]string, 0, 256)
	seen := make(map[string]struct{}, 256)
	for page := 0; page < 60 && nextURL != ""; page += 1 {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, nextURL, nil)
		if err != nil {
			return nil, 0, "", err
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "horcrux/dockerhub-query")
		if token != "" {
			req.Header.Set("Authorization", "JWT "+token)
		}
		resp, err := newRegistryHTTPClient().Do(req)
		if err != nil {
			return nil, 0, "", err
		}
		body, readErr := ioReadAllLimit(resp.Body, 4<<20)
		_ = resp.Body.Close()
		if readErr != nil {
			return nil, resp.StatusCode, "", readErr
		}
		if resp.StatusCode >= 400 {
			return nil, resp.StatusCode, extractRegistryErrorDetail(body), fmt.Errorf("dockerhub list repositories failed: %s", resp.Status)
		}
		var out dockerHubRepoListResp
		if err := json.Unmarshal(body, &out); err != nil {
			return nil, resp.StatusCode, bytesToSafeText(body, 260), err
		}
		for _, it := range out.Results {
			name := strings.TrimSpace(it.Name)
			if name == "" {
				continue
			}
			full := ns + "/" + name
			if _, ok := seen[full]; ok {
				continue
			}
			seen[full] = struct{}{}
			repos = append(repos, full)
		}
		nextURL = strings.TrimSpace(out.Next)
	}
	sort.Strings(repos)
	return repos, http.StatusOK, "", nil
}

func (h *Handler) ListRegistryTags(c *gin.Context) {
	credID := strings.TrimSpace(c.Query("cred_id"))
	repoRaw := strings.TrimSpace(c.Query("repo"))
	if repoRaw == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "repo is required"})
		return
	}
	registryOverride := strings.TrimSpace(c.Query("registry"))

	cred, err := h.findCredentialByID(credID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "vault load failed"})
		return
	}
	if cred != nil {
		user := strings.TrimSpace(cred.Username)
		pass := strings.TrimSpace(cred.Password)
		passMasked := cred.Password == "********"
		log.Printf("[API][registry] tags auth_check cred_id=%s user_len=%d pass_len=%d masked=%t", credID, len(user), len(pass), passMasked)
		if user != "" && (pass == "" || passMasked) {
			c.JSON(http.StatusBadRequest, gin.H{
				"error":           "Registry_Auth 密码为空或已被脱敏，请重新保存凭证密码后再试",
				"upstream_status": 0,
			})
			return
		}
	}

	repoRegistry, repoPath := splitRegistryAndRepo(repoRaw)
	registry := registryOverride
	if registry == "" {
		if repoRegistry != "" {
			registry = repoRegistry
		} else if cred != nil && cred.Registry != "" {
			registry = cred.Registry
		} else {
			registry = "docker.io"
		}
	}
	if repoPath == "" {
		repoPath = repoRaw
	}

	cacheKey := "tags|" + registry + "|" + credID + "|" + repoPath
	if values, ok := h.getCachedStringList(&h.registryTagsCache, cacheKey); ok {
		log.Printf("[API][registry] tags cache_hit cred_id=%s registry=%s repo=%s size=%d", credID, registry, repoPath, len(values))
		c.JSON(http.StatusOK, gin.H{"tags": values, "cached": true})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
	defer cancel()

	base := normalizeRegistryBase(registry)
	segments := strings.Split(repoPath, "/")
	for i := range segments {
		segments[i] = url.PathEscape(segments[i])
	}
	path := "/v2/" + strings.Join(segments, "/") + "/tags/list"
	body, _, statusCode, reqErr := h.registryGet(ctx, base, path, cred)
	if reqErr != nil {
		detail := extractRegistryErrorDetail(body)
		log.Printf(
			"[API][registry] tags error cred_id=%s registry=%s repo=%s url=%s status=%d err=%v detail=%s",
			credID,
			registry,
			repoPath,
			strings.TrimRight(base, "/")+path,
			statusCode,
			reqErr,
			detail,
		)
		msg := "failed to query tags"
		if statusCode == http.StatusUnauthorized {
			msg = "registry authentication failed"
		} else if statusCode == http.StatusForbidden {
			msg = "insufficient registry permissions"
		} else if statusCode >= 500 {
			msg = "registry temporarily unavailable"
		} else if statusCode == 0 {
			msg = "registry network request failed"
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": msg, "upstream_status": statusCode, "detail": detail})
		return
	}

	var payload struct {
		Name string   `json:"name"`
		Tags []string `json:"tags"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "版本标签返回数据解析失败"})
		return
	}

	tags := payload.Tags
	if tags == nil {
		tags = []string{}
	}
	sort.Strings(tags)
	h.setCachedStringList(&h.registryTagsCache, cacheKey, tags, 2*time.Minute)
	log.Printf("[API][registry] tags ok cred_id=%s registry=%s repo=%s size=%d", credID, registry, repoPath, len(tags))
	c.JSON(http.StatusOK, gin.H{"tags": tags, "cached": false})
}

type SyncTask struct {
	ID              string            `json:"id"`
	Mode            string            `json:"mode,omitempty"` // single, batch
	SourceRef       string            `json:"source_ref"`
	TargetRef       string            `json:"target_ref"`
	SourceID        string            `json:"source_id"`
	TargetID        string            `json:"target_id"`
	Targets         []TargetSyncState `json:"targets,omitempty"`
	Status          string            `json:"status"` // pending, running, success, failed, canceled
	FailFast        bool              `json:"fail_fast,omitempty"`
	MaxRetries      int               `json:"max_retries,omitempty"`
	Concurrency     int               `json:"concurrency,omitempty"`
	TimeoutSeconds  int               `json:"timeout_seconds,omitempty"`
	CancelRequested bool              `json:"cancel_requested,omitempty"`
	ErrorSummary    string            `json:"error_summary,omitempty"`
	CreatedAt       time.Time         `json:"created_at"`
	EndedAt         *time.Time        `json:"ended_at,omitempty"`
	Logs            []string          `json:"logs,omitempty"`
}

type TargetSyncState struct {
	TargetRef string     `json:"target_ref"`
	TargetID  string     `json:"target_id"`
	Status    string     `json:"status"` // pending, running, success, failed, canceled
	Progress  float64    `json:"progress,omitempty"`
	Attempts  int        `json:"attempts,omitempty"`
	Error     string     `json:"error,omitempty"`
	StartedAt *time.Time `json:"started_at,omitempty"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
}

func (h *Handler) getDataPath(sub ...string) string {
	base := ""
	if h != nil && h.vault != nil {
		base = h.vault.StorageDir()
	}

	// 如果 base 为空或者是当前目录，尝试定位到正确的 data 目录
	if base == "" || base == "." || base == "data" {
		// 检查当前目录下是否有 data
		if _, err := os.Stat("data"); err == nil {
			abs, err := filepath.Abs("data")
			if err == nil {
				base = abs
			} else {
				base = "data"
			}
		} else if _, err := os.Stat("backend/data"); err == nil {
			abs, err := filepath.Abs("backend/data")
			if err == nil {
				base = abs
			} else {
				base = "backend/data"
			}
		} else {
			// 默认创建在当前目录下的 data
			os.MkdirAll("data", 0755)
			abs, _ := filepath.Abs("data")
			base = abs
		}
	}

	paths := append([]string{base}, sub...)
	return filepath.Join(paths...)
}

func (h *Handler) ListTasks(c *gin.Context) {
	tasksDir := h.getDataPath("tasks")
	wd, _ := os.Getwd()
	fmt.Printf("[API] Listing tasks from %s (Working Dir: %s)\n", tasksDir, wd)

	if _, err := os.Stat(tasksDir); os.IsNotExist(err) {
		fmt.Printf("[API] Tasks directory does not exist at %s\n", tasksDir)
		c.JSON(http.StatusOK, gin.H{"tasks": []SyncTask{}})
		return
	}

	files, err := os.ReadDir(tasksDir)
	if err != nil {
		fmt.Printf("[API] Failed to read tasks directory: %v\n", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	fmt.Printf("[API] Found %d files in %s\n", len(files), tasksDir)

	tasks := []SyncTask{} // 明确初始化为空切片而非 nil
	parseErrors := []string{}
	for _, f := range files {
		if filepath.Ext(f.Name()) == ".json" {
			taskPath := filepath.Join(tasksDir, f.Name())
			data, err := os.ReadFile(taskPath)
			if err != nil {
				parseErrors = append(parseErrors, fmt.Sprintf("%s: read failed (%v)", f.Name(), err))
				continue
			}
			task, converted, warnings, err := parseTaskCompat(data, strings.TrimSuffix(f.Name(), filepath.Ext(f.Name())))
			if err != nil {
				parseErrors = append(parseErrors, fmt.Sprintf("%s: parse failed (%v)", f.Name(), err))
				continue
			}
			if converted {
				if err := writeTaskFile(taskPath, task); err != nil {
					parseErrors = append(parseErrors, fmt.Sprintf("%s: convert write failed (%v)", f.Name(), err))
				}
			}
			for _, w := range warnings {
				parseErrors = append(parseErrors, fmt.Sprintf("%s: %s", f.Name(), w))
			}

			task.Logs = nil
			tasks = append(tasks, *task)
		}
	}

	fmt.Printf("[API] Found %d tasks\n", len(tasks))

	// 按创建时间倒序排序
	sort.Slice(tasks, func(i, j int) bool {
		return tasks[i].CreatedAt.After(tasks[j].CreatedAt)
	})

	if len(parseErrors) > 0 {
		c.JSON(http.StatusOK, gin.H{"tasks": tasks, "errors": parseErrors})
		return
	}
	c.JSON(http.StatusOK, gin.H{"tasks": tasks})
}

func (h *Handler) GetStats(c *gin.Context) {
	creds, err := h.vault.LoadCredentials()
	if err != nil {
		fmt.Printf("[API] Failed to load credentials for stats: %v\n", err)
	}

	tasksDir := h.getDataPath("tasks")
	files, _ := os.ReadDir(tasksDir)

	totalTasks := 0
	activeTasks := 0
	for _, f := range files {
		if filepath.Ext(f.Name()) == ".json" {
			totalTasks++
			data, err := os.ReadFile(filepath.Join(tasksDir, f.Name()))
			if err == nil {
				var task SyncTask
				if err := json.Unmarshal(data, &task); err == nil {
					if task.Status == "running" {
						activeTasks++
					}
				}
			}
		}
	}

	fmt.Printf("[API] GetStats: creds=%d, tasks=%d, active=%d\n", len(creds), totalTasks, activeTasks)

	dataDir := h.getDataPath("")
	dataSize, _ := getDirSize(dataDir)
	throughputDisplay := formatBytes(dataSize)

	fmt.Printf("[API] GetStats: creds=%d, tasks=%d, active=%d, data_size=%s\n", len(creds), totalTasks, activeTasks, throughputDisplay)

	c.JSON(http.StatusOK, gin.H{
		"auth_keys":       len(creds),
		"active_threads":  activeTasks,
		"total_tasks":     totalTasks,
		"manifest_assets": totalTasks,
		"total_data_size": throughputDisplay,
	})
}

func (h *Handler) GetTask(c *gin.Context) {
	id := c.Param("id")
	tasksDir := h.getDataPath("tasks")
	taskPath := filepath.Join(tasksDir, id+".json")
	data, err := os.ReadFile(taskPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
		return
	}

	task, converted, warnings, err := parseTaskCompat(data, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Task format mismatch: %v", err)})
		return
	}
	if converted {
		_ = writeTaskFile(taskPath, task)
	}
	if len(warnings) > 0 {
		c.JSON(http.StatusOK, gin.H{"task": task, "warnings": warnings})
		return
	}
	c.JSON(http.StatusOK, task)
}

func (h *Handler) saveTask(task *SyncTask) {
	tasksDir := h.getDataPath("tasks")
	os.MkdirAll(tasksDir, 0755)
	data, _ := json.MarshalIndent(task, "", "  ")
	os.WriteFile(filepath.Join(tasksDir, task.ID+".json"), data, 0644)
}

func writeTaskFile(taskPath string, task *SyncTask) error {
	data, err := json.MarshalIndent(task, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(taskPath, data, 0644)
}

func parseTaskCompat(data []byte, fallbackID string) (*SyncTask, bool, []string, error) {
	var task SyncTask
	if err := json.Unmarshal(data, &task); err == nil {
		if strings.TrimSpace(task.ID) != "" && !task.CreatedAt.IsZero() {
			return &task, false, nil, nil
		}
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, false, nil, err
	}

	warnings := []string{}

	id := strings.TrimSpace(firstString(raw,
		"id", "ID", "task_id", "taskId", "taskID",
	))
	if id == "" {
		id = strings.TrimSpace(fallbackID)
	}
	if id == "" {
		warnings = append(warnings, "missing id, fallback to generated id")
		id = fmt.Sprintf("task_%d", time.Now().UnixNano())
	}

	status := strings.TrimSpace(firstString(raw, "status", "state", "Status", "State"))
	switch strings.ToLower(status) {
	case "completed", "done", "ok":
		status = "success"
	case "error":
		status = "failed"
	}
	if status == "" {
		status = "unknown"
		warnings = append(warnings, "missing status, set to unknown")
	}

	sourceRef := strings.TrimSpace(firstString(raw, "source_ref", "sourceRef", "source", "src_ref", "srcRef"))
	targetRef := strings.TrimSpace(firstString(raw, "target_ref", "targetRef", "target", "dst_ref", "dstRef"))
	sourceID := strings.TrimSpace(firstString(raw, "source_id", "sourceId", "sourceID"))
	targetID := strings.TrimSpace(firstString(raw, "target_id", "targetId", "targetID"))

	createdAt, okCreated := firstTime(raw, "created_at", "createdAt", "created", "CreatedAt")
	if !okCreated {
		createdAt = time.Now()
		warnings = append(warnings, "missing created_at, set to now")
	}
	endedAt, okEnded := firstTimePtr(raw, "ended_at", "endedAt", "ended", "EndedAt", "finished_at", "finishedAt")
	if !okEnded {
		endedAt = nil
	}

	mode := strings.TrimSpace(firstString(raw, "mode", "Mode", "task_mode", "taskMode"))
	if mode == "" {
		mode = "batch"
	}

	failFast := firstBool(raw, "fail_fast", "failFast", "FailFast")
	maxRetries := firstInt(raw, "max_retries", "maxRetries", "MaxRetries")
	concurrency := firstInt(raw, "concurrency", "Concurrency")
	timeoutSeconds := firstInt(raw, "timeout_seconds", "timeoutSeconds", "TimeoutSeconds")
	cancelRequested := firstBool(raw, "cancel_requested", "cancelRequested", "CancelRequested")
	errorSummary := strings.TrimSpace(firstString(raw, "error_summary", "errorSummary", "ErrorSummary"))

	logs, logsWarn := extractLogs(raw, "logs", "log", "history", "entries", "log_entries", "logEntries")
	warnings = append(warnings, logsWarn...)

	targetStates, targetsWarn := extractTargets(raw, "targets", "Targets", "target_states", "targetStates")
	warnings = append(warnings, targetsWarn...)
	if targetRef == "" && len(targetStates) > 0 && strings.TrimSpace(targetStates[0].TargetRef) != "" {
		targetRef = strings.TrimSpace(targetStates[0].TargetRef)
	}

	out := &SyncTask{
		ID:              id,
		Mode:            mode,
		SourceRef:       sourceRef,
		TargetRef:       targetRef,
		SourceID:        sourceID,
		TargetID:        targetID,
		Targets:         targetStates,
		Status:          status,
		FailFast:        failFast,
		MaxRetries:      maxRetries,
		Concurrency:     concurrency,
		TimeoutSeconds:  timeoutSeconds,
		CancelRequested: cancelRequested,
		ErrorSummary:    errorSummary,
		CreatedAt:       createdAt,
		EndedAt:         endedAt,
		Logs:            logs,
	}

	return out, true, warnings, nil
}

func firstString(raw map[string]any, keys ...string) string {
	for _, k := range keys {
		v, ok := raw[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case string:
			if strings.TrimSpace(t) != "" {
				return t
			}
		case fmt.Stringer:
			s := t.String()
			if strings.TrimSpace(s) != "" {
				return s
			}
		default:
			s := fmt.Sprintf("%v", v)
			if strings.TrimSpace(s) != "" && s != "<nil>" {
				return s
			}
		}
	}
	return ""
}

func firstBool(raw map[string]any, keys ...string) bool {
	for _, k := range keys {
		v, ok := raw[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case bool:
			return t
		case string:
			if b, err := strconv.ParseBool(strings.TrimSpace(t)); err == nil {
				return b
			}
		case float64:
			return t != 0
		}
	}
	return false
}

func firstInt(raw map[string]any, keys ...string) int {
	for _, k := range keys {
		v, ok := raw[k]
		if !ok {
			continue
		}
		switch t := v.(type) {
		case float64:
			return int(t)
		case int:
			return t
		case int64:
			return int(t)
		case string:
			s := strings.TrimSpace(t)
			if s == "" {
				continue
			}
			if i, err := strconv.Atoi(s); err == nil {
				return i
			}
		}
	}
	return 0
}

func firstTime(raw map[string]any, keys ...string) (time.Time, bool) {
	for _, k := range keys {
		v, ok := raw[k]
		if !ok {
			continue
		}
		t, ok := parseTimeValue(v)
		if ok {
			return t, true
		}
	}
	return time.Time{}, false
}

func firstTimePtr(raw map[string]any, keys ...string) (*time.Time, bool) {
	t, ok := firstTime(raw, keys...)
	if !ok {
		return nil, false
	}
	return &t, true
}

func parseTimeValue(v any) (time.Time, bool) {
	switch t := v.(type) {
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return time.Time{}, false
		}
		if ts, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return ts, true
		}
		if ts, err := time.Parse(time.RFC3339, s); err == nil {
			return ts, true
		}
		if n, err := strconv.ParseInt(s, 10, 64); err == nil {
			return parseUnixNumeric(n)
		}
	case float64:
		return parseUnixNumeric(int64(t))
	case int64:
		return parseUnixNumeric(t)
	case int:
		return parseUnixNumeric(int64(t))
	}
	return time.Time{}, false
}

func parseUnixNumeric(n int64) (time.Time, bool) {
	switch {
	case n > 1e18:
		return time.Unix(0, n), true
	case n > 1e15:
		return time.Unix(0, n*1e3), true
	case n > 1e12:
		return time.UnixMilli(n), true
	case n > 1e9:
		return time.Unix(n, 0), true
	default:
		return time.Time{}, false
	}
}

func extractLogs(raw map[string]any, keys ...string) ([]string, []string) {
	for _, k := range keys {
		v, ok := raw[k]
		if !ok {
			continue
		}
		logs, warn, ok := normalizeLogs(v)
		if ok {
			return logs, warn
		}
	}
	return nil, nil
}

func normalizeLogs(v any) ([]string, []string, bool) {
	switch t := v.(type) {
	case nil:
		return nil, nil, true
	case string:
		s := strings.ReplaceAll(t, "\r\n", "\n")
		s = strings.TrimSpace(s)
		if s == "" {
			return []string{}, nil, true
		}
		parts := strings.Split(s, "\n")
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			out = append(out, p)
		}
		return out, nil, true
	case []any:
		out := make([]string, 0, len(t))
		warnings := []string{}
		for _, item := range t {
			switch it := item.(type) {
			case string:
				s := strings.TrimSpace(it)
				if s != "" {
					out = append(out, s)
				}
			case map[string]any:
				line, ok := formatLogObject(it)
				if ok {
					out = append(out, line)
				} else {
					warnings = append(warnings, "some log entries could not be normalized")
				}
			default:
				s := strings.TrimSpace(fmt.Sprintf("%v", item))
				if s != "" && s != "<nil>" {
					out = append(out, s)
				}
			}
		}
		return out, warnings, true
	default:
		return nil, nil, false
	}
}

func formatLogObject(m map[string]any) (string, bool) {
	msg := strings.TrimSpace(firstString(m, "message", "msg", "text", "line", "content"))
	if msg == "" {
		msg = strings.TrimSpace(fmt.Sprintf("%v", m))
	}
	level := strings.TrimSpace(firstString(m, "level", "Level", "severity", "type"))
	tsRaw := strings.TrimSpace(firstString(m, "time", "timestamp", "ts", "at", "date"))

	prefix := ""
	if tsRaw != "" {
		if ts, ok := parseTimeValue(tsRaw); ok {
			prefix = ts.Format("15:04:05")
		} else {
			prefix = tsRaw
		}
	}

	switch {
	case prefix != "" && level != "":
		return fmt.Sprintf("%s [%s] %s", prefix, level, msg), true
	case prefix != "":
		return fmt.Sprintf("%s %s", prefix, msg), true
	case level != "":
		return fmt.Sprintf("[%s] %s", level, msg), true
	default:
		return msg, msg != ""
	}
}

func extractTargets(raw map[string]any, keys ...string) ([]TargetSyncState, []string) {
	for _, k := range keys {
		v, ok := raw[k]
		if !ok {
			continue
		}
		out, warn, ok := normalizeTargets(v)
		if ok {
			return out, warn
		}
	}
	return nil, nil
}

func normalizeTargets(v any) ([]TargetSyncState, []string, bool) {
	arr, ok := v.([]any)
	if !ok {
		return nil, nil, false
	}
	out := make([]TargetSyncState, 0, len(arr))
	warnings := []string{}
	for _, item := range arr {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		targetRef := strings.TrimSpace(firstString(m, "target_ref", "targetRef", "ref", "TargetRef"))
		targetID := strings.TrimSpace(firstString(m, "target_id", "targetId", "TargetID"))
		status := strings.TrimSpace(firstString(m, "status", "state", "Status", "State"))
		if strings.ToLower(status) == "completed" {
			status = "success"
		}
		progress := 0.0
		if pv, ok := m["progress"].(float64); ok {
			progress = pv
		} else if pv, ok := m["Progress"].(float64); ok {
			progress = pv
		}
		attempts := firstInt(m, "attempts", "Attempts", "tries")
		errMsg := strings.TrimSpace(firstString(m, "error", "Error", "message"))
		startedAt, okStart := firstTimePtr(m, "started_at", "startedAt", "start_at", "startAt")
		endedAt, okEnd := firstTimePtr(m, "ended_at", "endedAt", "end_at", "endAt")

		if targetRef == "" && targetID == "" {
			warnings = append(warnings, "some target entries missing identifiers")
		}
		if !okStart {
			startedAt = nil
		}
		if !okEnd {
			endedAt = nil
		}

		out = append(out, TargetSyncState{
			TargetRef: targetRef,
			TargetID:  targetID,
			Status:    status,
			Progress:  progress,
			Attempts:  attempts,
			Error:     errMsg,
			StartedAt: startedAt,
			EndedAt:   endedAt,
		})
	}
	return out, warnings, true
}

func (h *Handler) logTask(task *SyncTask, msg string) {
	formattedMsg := fmt.Sprintf("%s %s", time.Now().Format("15:04:05"), msg)
	task.Logs = append(task.Logs, formattedMsg)
	h.saveTask(task)
	h.hub.Broadcast(fmt.Sprintf("TASK_LOG:%s:%s", task.ID, formattedMsg))
}

type TaskEvent struct {
	Type            string  `json:"type"`
	TaskID          string  `json:"task_id"`
	Status          string  `json:"status,omitempty"`
	CancelRequested bool    `json:"cancel_requested,omitempty"`
	TargetRef       string  `json:"target_ref,omitempty"`
	TargetStatus    string  `json:"target_status,omitempty"`
	Progress        float64 `json:"progress,omitempty"`
	Attempts        int     `json:"attempts,omitempty"`
	Error           string  `json:"error,omitempty"`
}

func (h *Handler) broadcastTaskEvent(e TaskEvent) {
	if h == nil || h.hub == nil {
		return
	}
	data, err := json.Marshal(e)
	if err != nil {
		return
	}
	h.hub.Broadcast(fmt.Sprintf("TASK_EVENT:%s:%s", e.TaskID, string(data)))
}

type SyncTargetRequest struct {
	TargetRef string `json:"target_ref"`
	TargetID  string `json:"target_id"`
}

type SyncRequest struct {
	SourceRef      string              `json:"source_ref"`
	TargetRef      string              `json:"target_ref"`
	SourceID       string              `json:"source_id"`
	TargetID       string              `json:"target_id"`
	Targets        []SyncTargetRequest `json:"targets"`
	Concurrency    *int                `json:"concurrency"`
	MaxRetries     *int                `json:"max_retries"`
	FailFast       *bool               `json:"fail_fast"`
	TimeoutSeconds *int                `json:"timeout_seconds"`
}

func findCredentialByID(creds []vault.Credential, id string) *vault.Credential {
	if id == "" {
		return nil
	}
	for i := range creds {
		if creds[i].ID == id {
			cred := creds[i]
			return &cred
		}
	}
	return nil
}

func normalizeRegistryHost(registry string) string {
	r := strings.TrimSpace(registry)
	r = strings.TrimPrefix(r, "https://")
	r = strings.TrimPrefix(r, "http://")
	r = strings.TrimSuffix(r, "/")
	r = strings.TrimSuffix(r, "/v1")
	r = strings.TrimSuffix(r, "/v1/")
	return r
}

func isDockerHubRegistry(registry string) bool {
	switch normalizeRegistryHost(registry) {
	case "", "docker.io", "index.docker.io", "registry-1.docker.io":
		return true
	default:
		return false
	}
}

func refHasExplicitRegistry(ref string) bool {
	r := strings.TrimSpace(ref)
	if r == "" {
		return false
	}
	first := r
	if idx := strings.IndexByte(r, '/'); idx >= 0 {
		first = r[:idx]
	}
	if first == "localhost" {
		return true
	}
	return strings.Contains(first, ".") || strings.Contains(first, ":")
}

func normalizeImageRef(ref string, cred *vault.Credential) (string, bool) {
	r := strings.TrimSpace(ref)
	if r == "" || cred == nil {
		return r, false
	}

	registry := normalizeRegistryHost(cred.Registry)
	if registry == "" || isDockerHubRegistry(registry) {
		return r, false
	}
	if refHasExplicitRegistry(r) {
		return r, false
	}

	return registry + "/" + r, true
}

type Pipe struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Nodes       []any     `json:"nodes"`
	Edges       []any     `json:"edges"`
	Version     int       `json:"version"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type PipeVersion struct {
	Version   int       `json:"version"`
	UpdatedAt time.Time `json:"updated_at"`
}

type PipeOp struct {
	TS   string `json:"ts"`
	Kind string `json:"kind"`
	Data any    `json:"data,omitempty"`
}

func (h *Handler) SavePipe(c *gin.Context) {
	var pipe Pipe
	if err := c.ShouldBindJSON(&pipe); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	pipe.ID = strings.TrimSpace(pipe.ID)
	pipe.Name = strings.TrimSpace(pipe.Name)
	pipe.Description = strings.TrimSpace(pipe.Description)

	if pipe.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}

	created := false
	h.pipesMu.Lock()
	defer h.pipesMu.Unlock()

	if pipe.ID == "" {
		pipe.ID = fmt.Sprintf("pipe_%d", time.Now().UnixNano())
		created = true
	}
	if !isSafePipeID(pipe.ID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pipe id"})
		return
	}

	existing, err := h.loadPipeLocked(pipe.ID)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			created = true
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load pipe: " + err.Error()})
			return
		}
	}

	now := time.Now()
	if existing != nil {
		if existing.CreatedAt.IsZero() {
			if !existing.UpdatedAt.IsZero() {
				pipe.CreatedAt = existing.UpdatedAt
			} else {
				pipe.CreatedAt = now
			}
		} else {
			pipe.CreatedAt = existing.CreatedAt
		}
		pipe.Version = existing.Version + 1
	} else {
		pipe.CreatedAt = now
		pipe.Version = 1
	}
	pipe.UpdatedAt = now

	pipesDir := h.getDataPath("pipes")
	if err := os.MkdirAll(pipesDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create pipes dir: " + err.Error()})
		return
	}
	data, _ := json.MarshalIndent(pipe, "", "  ")
	if err := writeFileAtomic(filepath.Join(pipesDir, pipe.ID+".json"), data, 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save pipe: " + err.Error()})
		return
	}
	if err := h.savePipeVersionLocked(pipe); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save pipe version: " + err.Error()})
		return
	}

	if created {
		c.JSON(http.StatusCreated, pipe)
		return
	}
	c.JSON(http.StatusOK, pipe)
}

func (h *Handler) ListPipes(c *gin.Context) {
	id := strings.TrimSpace(c.Query("id"))
	name := strings.TrimSpace(c.Query("name"))
	metaOnly := strings.TrimSpace(c.Query("meta_only")) == "1"
	withTotal := strings.TrimSpace(c.Query("with_total")) == "1"

	limit := 0
	offset := 0
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			limit = v
		}
	}
	if raw := strings.TrimSpace(c.Query("offset")); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			offset = v
		}
	}

	pipesDir := h.getDataPath("pipes")
	if _, err := os.Stat(pipesDir); os.IsNotExist(err) {
		if withTotal {
			c.JSON(http.StatusOK, gin.H{"items": []Pipe{}, "total": 0})
			return
		}
		c.JSON(http.StatusOK, []Pipe{})
		return
	}

	files, err := os.ReadDir(pipesDir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var pipes []Pipe
	for _, f := range files {
		if filepath.Ext(f.Name()) == ".json" {
			data, err := os.ReadFile(filepath.Join(pipesDir, f.Name()))
			if err != nil {
				continue
			}
			var pipe Pipe
			if err := json.Unmarshal(data, &pipe); err == nil {
				if id != "" && pipe.ID != id {
					continue
				}
				if name != "" && !strings.Contains(strings.ToLower(pipe.Name), strings.ToLower(name)) {
					continue
				}
				out := normalizePipeLoaded(pipe)
				if metaOnly {
					out.Nodes = nil
					out.Edges = nil
				}
				pipes = append(pipes, out)
			}
		}
	}

	sort.Slice(pipes, func(i, j int) bool {
		return pipes[i].UpdatedAt.After(pipes[j].UpdatedAt)
	})

	total := len(pipes)
	out := pipes
	if limit > 0 {
		if offset >= total {
			out = []Pipe{}
		} else {
			end := offset + limit
			if end > total {
				end = total
			}
			out = pipes[offset:end]
		}
		c.Header("X-Total-Count", strconv.Itoa(total))
	}

	if withTotal {
		c.JSON(http.StatusOK, gin.H{"items": out, "total": total})
		return
	}
	c.JSON(http.StatusOK, out)
}

func (h *Handler) GetPipe(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if !isSafePipeID(id) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pipe id"})
		return
	}

	h.pipesMu.Lock()
	defer h.pipesMu.Unlock()

	pipe, err := h.loadPipeLocked(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.JSON(http.StatusNotFound, gin.H{"error": "pipe not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load pipe: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, normalizePipeLoaded(*pipe))
}

func (h *Handler) UpdatePipe(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if !isSafePipeID(id) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pipe id"})
		return
	}

	autoSave := strings.TrimSpace(c.Query("autosave")) == "1"
	force := strings.TrimSpace(c.Query("force")) == "1" || strings.TrimSpace(c.Query("overwrite")) == "1"
	baseUpdatedAtRaw := strings.TrimSpace(c.Query("base_updated_at"))

	var in Pipe
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	in.Description = strings.TrimSpace(in.Description)
	if in.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}

	h.pipesMu.Lock()
	defer h.pipesMu.Unlock()

	existing, err := h.loadPipeLocked(id)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.JSON(http.StatusNotFound, gin.H{"error": "pipe not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load pipe: " + err.Error()})
		return
	}

	if baseUpdatedAtRaw != "" && !force {
		baseUpdatedAt, err := parseRFC3339Time(baseUpdatedAtRaw)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid base_updated_at"})
			return
		}
		if existing.UpdatedAt.UnixNano() != baseUpdatedAt.UnixNano() {
			c.JSON(http.StatusConflict, gin.H{
				"error":              "pipe update conflict",
				"current_version":    existing.Version,
				"current_updated_at": existing.UpdatedAt.Format(time.RFC3339Nano),
			})
			return
		}
	}

	now := time.Now()
	nextVersion := existing.Version + 1
	if autoSave {
		nextVersion = existing.Version
	}
	out := Pipe{
		ID:          id,
		Name:        in.Name,
		Description: in.Description,
		Nodes:       in.Nodes,
		Edges:       in.Edges,
		Version:     nextVersion,
		CreatedAt:   existing.CreatedAt,
		UpdatedAt:   now,
	}
	if out.CreatedAt.IsZero() {
		if !existing.UpdatedAt.IsZero() {
			out.CreatedAt = existing.UpdatedAt
		} else {
			out.CreatedAt = now
		}
	}

	pipesDir := h.getDataPath("pipes")
	if err := os.MkdirAll(pipesDir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create pipes dir: " + err.Error()})
		return
	}
	data, _ := json.MarshalIndent(out, "", "  ")
	if err := writeFileAtomic(filepath.Join(pipesDir, out.ID+".json"), data, 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save pipe: " + err.Error()})
		return
	}
	if !autoSave {
		if err := h.savePipeVersionLocked(out); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save pipe version: " + err.Error()})
			return
		}
	}
	c.JSON(http.StatusOK, out)
}

func parseRFC3339Time(v string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, v)
}

func (h *Handler) DeletePipe(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if !isSafePipeID(id) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pipe id"})
		return
	}

	h.pipesMu.Lock()
	defer h.pipesMu.Unlock()

	pipesDir := h.getDataPath("pipes")
	if err := os.Remove(filepath.Join(pipesDir, id+".json")); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.JSON(http.StatusNotFound, gin.H{"error": "pipe not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete pipe: " + err.Error()})
		return
	}

	versionsDir := h.getDataPath("pipes", "versions", id)
	_ = os.RemoveAll(versionsDir)
	opsDir := h.getDataPath("pipes", "ops", id)
	_ = os.RemoveAll(opsDir)
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

func (h *Handler) ListPipeVersions(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if !isSafePipeID(id) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pipe id"})
		return
	}

	h.pipesMu.Lock()
	defer h.pipesMu.Unlock()

	if _, err := h.loadPipeLocked(id); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.JSON(http.StatusNotFound, gin.H{"error": "pipe not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load pipe: " + err.Error()})
		return
	}

	versions, err := h.listPipeVersionsLocked(id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list versions: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, versions)
}

func (h *Handler) GetPipeVersion(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if !isSafePipeID(id) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pipe id"})
		return
	}
	vRaw := strings.TrimSpace(c.Param("version"))
	v, err := strconv.Atoi(vRaw)
	if err != nil || v <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid version"})
		return
	}

	h.pipesMu.Lock()
	defer h.pipesMu.Unlock()

	pipe, err := h.loadPipeVersionLocked(id, v)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.JSON(http.StatusNotFound, gin.H{"error": "version not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load version: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, normalizePipeLoaded(*pipe))
}

func (h *Handler) AppendPipeOps(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if !isSafePipeID(id) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pipe id"})
		return
	}

	var ops []PipeOp
	if err := c.ShouldBindJSON(&ops); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(ops) == 0 {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
		return
	}
	if len(ops) > 2000 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "too many ops"})
		return
	}

	now := time.Now()
	cleaned := make([]PipeOp, 0, len(ops))
	for i := range ops {
		kind := strings.TrimSpace(ops[i].Kind)
		if kind == "" {
			continue
		}
		ts := strings.TrimSpace(ops[i].TS)
		if ts == "" {
			ts = now.Format(time.RFC3339Nano)
		}
		cleaned = append(cleaned, PipeOp{TS: ts, Kind: kind, Data: ops[i].Data})
	}
	if len(cleaned) == 0 {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
		return
	}

	h.pipesMu.Lock()
	defer h.pipesMu.Unlock()

	if _, err := h.loadPipeLocked(id); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.JSON(http.StatusNotFound, gin.H{"error": "pipe not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load pipe: " + err.Error()})
		return
	}

	dir := h.getDataPath("pipes", "ops", id)
	if err := os.MkdirAll(dir, 0755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create ops dir: " + err.Error()})
		return
	}
	data, err := json.Marshal(cleaned)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to encode ops: " + err.Error()})
		return
	}

	name := fmt.Sprintf("b_%019d.json", time.Now().UnixNano())
	if err := writeFileAtomic(filepath.Join(dir, name), data, 0644); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to append ops: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func (h *Handler) ListPipeOps(c *gin.Context) {
	id := strings.TrimSpace(c.Param("id"))
	if !isSafePipeID(id) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pipe id"})
		return
	}

	limit := 200
	if v := strings.TrimSpace(c.Query("limit")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 1000 {
		limit = 1000
	}

	h.pipesMu.Lock()
	defer h.pipesMu.Unlock()

	if _, err := h.loadPipeLocked(id); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			c.JSON(http.StatusNotFound, gin.H{"error": "pipe not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load pipe: " + err.Error()})
		return
	}

	dir := h.getDataPath("pipes", "ops", id)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		c.JSON(http.StatusOK, []PipeOp{})
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list ops: " + err.Error()})
		return
	}

	files := make([]string, 0, len(entries))
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			continue
		}
		files = append(files, e.Name())
	}
	sort.Slice(files, func(i, j int) bool { return files[i] > files[j] })

	out := make([]PipeOp, 0, limit)
	for _, name := range files {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var batch []PipeOp
		if err := json.Unmarshal(b, &batch); err != nil {
			continue
		}
		for i := len(batch) - 1; i >= 0; i-- {
			out = append(out, batch[i])
			if len(out) >= limit {
				c.JSON(http.StatusOK, out)
				return
			}
		}
	}
	c.JSON(http.StatusOK, out)
}

func normalizePipeLoaded(pipe Pipe) Pipe {
	if pipe.CreatedAt.IsZero() {
		if !pipe.UpdatedAt.IsZero() {
			pipe.CreatedAt = pipe.UpdatedAt
		} else {
			pipe.CreatedAt = time.Now()
		}
	}
	if pipe.Version <= 0 {
		pipe.Version = 1
	}
	return pipe
}

func isSafePipeID(id string) bool {
	if id == "" {
		return false
	}
	if id != filepath.Base(id) {
		return false
	}
	if strings.Contains(id, "..") {
		return false
	}
	return !strings.ContainsAny(id, `/\`)
}

func (h *Handler) loadPipeLocked(id string) (*Pipe, error) {
	pipesDir := h.getDataPath("pipes")
	data, err := os.ReadFile(filepath.Join(pipesDir, id+".json"))
	if err != nil {
		return nil, err
	}
	var out Pipe
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	out = normalizePipeLoaded(out)
	return &out, nil
}

func (h *Handler) savePipeVersionLocked(pipe Pipe) error {
	baseDir := h.getDataPath("pipes", "versions", pipe.ID)
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(pipe, "", "  ")
	if err != nil {
		return err
	}
	name := fmt.Sprintf("v%d_%d.json", pipe.Version, pipe.UpdatedAt.UnixNano())
	return writeFileAtomic(filepath.Join(baseDir, name), data, 0644)
}

func (h *Handler) listPipeVersionsLocked(id string) ([]PipeVersion, error) {
	dir := h.getDataPath("pipes", "versions", id)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return []PipeVersion{}, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	seen := map[int]PipeVersion{}
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var p Pipe
		if err := json.Unmarshal(data, &p); err != nil {
			continue
		}
		p = normalizePipeLoaded(p)
		cur, ok := seen[p.Version]
		if !ok || p.UpdatedAt.After(cur.UpdatedAt) {
			seen[p.Version] = PipeVersion{Version: p.Version, UpdatedAt: p.UpdatedAt}
		}
	}

	out := make([]PipeVersion, 0, len(seen))
	for _, v := range seen {
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Version > out[j].Version
	})
	return out, nil
}

func (h *Handler) loadPipeVersionLocked(id string, version int) (*Pipe, error) {
	dir := h.getDataPath("pipes", "versions", id)
	if _, err := os.Stat(dir); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}

	var picked string
	var pickedUpdated time.Time
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, fmt.Sprintf("v%d_", version)) || filepath.Ext(name) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		var p Pipe
		if err := json.Unmarshal(data, &p); err != nil {
			continue
		}
		p = normalizePipeLoaded(p)
		if picked == "" || p.UpdatedAt.After(pickedUpdated) {
			picked = filepath.Join(dir, name)
			pickedUpdated = p.UpdatedAt
		}
	}
	if picked == "" {
		return nil, os.ErrNotExist
	}
	data, err := os.ReadFile(picked)
	if err != nil {
		return nil, err
	}
	var out Pipe
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	out = normalizePipeLoaded(out)
	return &out, nil
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, perm); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func (h *Handler) ExecuteSync(c *gin.Context) {
	var req SyncRequest
	if v, ok := c.Get("retry_request"); ok {
		switch r := v.(type) {
		case SyncRequest:
			req = r
		case *SyncRequest:
			if r != nil {
				req = *r
			}
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid retry request"})
			return
		}
	} else {
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	sourceRefRaw := strings.TrimSpace(req.SourceRef)
	if sourceRefRaw == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "source_ref is required"})
		return
	}

	targetsInput := req.Targets
	if len(targetsInput) == 0 && strings.TrimSpace(req.TargetRef) != "" {
		targetsInput = []SyncTargetRequest{{
			TargetRef: req.TargetRef,
			TargetID:  req.TargetID,
		}}
	}
	if len(targetsInput) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "target_ref or targets is required"})
		return
	}

	creds, _ := h.vault.LoadCredentials()
	srcAuth := findCredentialByID(creds, strings.TrimSpace(req.SourceID))
	sourceRef := sourceRefRaw
	if normalized, changed := normalizeImageRef(sourceRef, srcAuth); changed {
		sourceRef = normalized
	}

	seenTargets := make(map[string]bool, len(targetsInput))
	deduped := make([]SyncTargetRequest, 0, len(targetsInput))
	for _, t := range targetsInput {
		ref := strings.TrimSpace(t.TargetRef)
		if ref == "" {
			continue
		}
		targetID := strings.TrimSpace(t.TargetID)
		dstAuth := findCredentialByID(creds, targetID)
		targetRef := ref
		if normalized, changed := normalizeImageRef(targetRef, dstAuth); changed {
			targetRef = normalized
		}

		if seenTargets[targetRef] {
			continue
		}
		seenTargets[targetRef] = true
		deduped = append(deduped, SyncTargetRequest{TargetRef: targetRef, TargetID: targetID})
	}
	if len(deduped) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no valid targets provided"})
		return
	}

	concurrency := 2
	if req.Concurrency != nil && *req.Concurrency > 0 {
		concurrency = *req.Concurrency
	}
	if concurrency > len(deduped) {
		concurrency = len(deduped)
	}

	maxRetries := 2
	if req.MaxRetries != nil && *req.MaxRetries >= 0 {
		maxRetries = *req.MaxRetries
	}

	failFast := len(deduped) == 1
	if req.FailFast != nil {
		failFast = *req.FailFast
	}

	timeoutSeconds := 3600
	if req.TimeoutSeconds != nil && *req.TimeoutSeconds > 0 {
		timeoutSeconds = *req.TimeoutSeconds
	}

	task := &SyncTask{
		ID:             fmt.Sprintf("task_%d", time.Now().UnixNano()),
		Mode:           "batch",
		SourceRef:      sourceRef,
		SourceID:       strings.TrimSpace(req.SourceID),
		Status:         "running",
		FailFast:       failFast,
		MaxRetries:     maxRetries,
		Concurrency:    concurrency,
		TimeoutSeconds: timeoutSeconds,
		CreatedAt:      time.Now(),
		Logs:           []string{"Task initialized"},
	}
	if len(deduped) == 1 {
		task.Mode = "single"
		task.TargetRef = deduped[0].TargetRef
		task.TargetID = deduped[0].TargetID
	}

	task.Targets = make([]TargetSyncState, 0, len(deduped))
	for _, t := range deduped {
		task.Targets = append(task.Targets, TargetSyncState{
			TargetRef: t.TargetRef,
			TargetID:  t.TargetID,
			Status:    "pending",
			Progress:  0,
			Attempts:  0,
		})
	}

	h.saveTask(task)
	h.logTask(task, "Starting synchronization process...")
	if sourceRef != sourceRefRaw {
		h.logTask(task, fmt.Sprintf("Normalized source reference: %s -> %s", sourceRefRaw, sourceRef))
	}
	h.broadcastTaskEvent(TaskEvent{Type: "task_update", TaskID: task.ID, Status: task.Status})

	ctx, cancel := context.WithCancel(context.Background())
	h.activeTaskCancels.Store(task.ID, cancel)

	go h.runBatchSync(ctx, cancel, task, srcAuth, creds)

	c.JSON(http.StatusOK, task)
}

type retryRequest struct {
	TargetRefs []string `json:"target_refs"`
	FailedOnly *bool    `json:"failed_only"`
}

func (h *Handler) RetryTask(c *gin.Context) {
	id := c.Param("id")
	orig, err := h.loadTask(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
		return
	}
	if orig.Status == "running" {
		c.JSON(http.StatusConflict, gin.H{"error": "Task is still running"})
		return
	}

	var rr retryRequest
	_ = c.ShouldBindJSON(&rr)
	failedOnly := true
	if rr.FailedOnly != nil {
		failedOnly = *rr.FailedOnly
	}

	filter := map[string]bool{}
	for _, r := range rr.TargetRefs {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		filter[r] = true
	}

	targets := make([]SyncTargetRequest, 0, len(orig.Targets))
	for _, t := range orig.Targets {
		if len(filter) > 0 && !filter[t.TargetRef] {
			continue
		}
		if failedOnly && t.Status != "failed" {
			continue
		}
		targets = append(targets, SyncTargetRequest{TargetRef: t.TargetRef, TargetID: t.TargetID})
	}
	if len(targets) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No targets to retry"})
		return
	}

	req := SyncRequest{
		SourceRef: orig.SourceRef,
		SourceID:  orig.SourceID,
		Targets:   targets,
	}
	if orig.Concurrency > 0 {
		req.Concurrency = &orig.Concurrency
	}
	if orig.MaxRetries >= 0 {
		req.MaxRetries = &orig.MaxRetries
	}
	if orig.TimeoutSeconds > 0 {
		req.TimeoutSeconds = &orig.TimeoutSeconds
	}
	ff := orig.FailFast
	req.FailFast = &ff

	c.Set("retry_request", req)
	h.ExecuteSync(c)
}

func (h *Handler) CancelTask(c *gin.Context) {
	id := c.Param("id")
	task, err := h.loadTask(id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Task not found"})
		return
	}

	task.CancelRequested = true
	h.saveTask(task)
	h.broadcastTaskEvent(TaskEvent{Type: "task_update", TaskID: id, Status: task.Status, CancelRequested: true})

	if v, ok := h.activeTaskCancels.Load(id); ok {
		if cancel, ok := v.(context.CancelFunc); ok {
			cancel()
		}
	}

	c.JSON(http.StatusOK, gin.H{"status": "cancel_requested"})
}

func (h *Handler) loadTask(id string) (*SyncTask, error) {
	tasksDir := h.getDataPath("tasks")
	taskPath := filepath.Join(tasksDir, id+".json")
	data, err := os.ReadFile(taskPath)
	if err != nil {
		return nil, err
	}
	task, converted, _, err := parseTaskCompat(data, id)
	if err != nil {
		return nil, err
	}
	if converted {
		_ = writeTaskFile(taskPath, task)
	}
	return task, nil
}

func (h *Handler) runBatchSync(ctx context.Context, cancel context.CancelFunc, task *SyncTask, srcAuth *vault.Credential, creds []vault.Credential) {
	updateCh := make(chan func(), 1024)
	var applyWg sync.WaitGroup
	applyWg.Add(1)
	go func() {
		defer applyWg.Done()
		for fn := range updateCh {
			fn()
		}
	}()

	apply := func(fn func()) {
		updateCh <- fn
	}

	defer func() {
		if cancel != nil {
			cancel()
		}
		h.activeTaskCancels.Delete(task.ID)
		close(updateCh)
		applyWg.Wait()
	}()

	sem := make(chan struct{}, task.Concurrency)
	var wg sync.WaitGroup

	for i := range task.Targets {
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			defer func() { <-sem }()
			h.runSingleTargetSync(ctx, cancel, task, idx, srcAuth, creds, apply)
		}(i)
	}

	wg.Wait()

	apply(func() {
		defer func() {
			now := time.Now()
			task.EndedAt = &now
			h.saveTask(task)
		}()

		anyFailed := false
		anyCanceled := task.CancelRequested
		var errorParts []string
		for i := range task.Targets {
			switch task.Targets[i].Status {
			case "failed":
				anyFailed = true
				if strings.TrimSpace(task.Targets[i].Error) != "" {
					errorParts = append(errorParts, fmt.Sprintf("%s: %s", task.Targets[i].TargetRef, task.Targets[i].Error))
				} else {
					errorParts = append(errorParts, fmt.Sprintf("%s: failed", task.Targets[i].TargetRef))
				}
			case "canceled":
				anyCanceled = true
			case "pending", "running":
				task.Targets[i].Status = "canceled"
				anyCanceled = true
			}
		}

		switch {
		case anyFailed:
			task.Status = "failed"
		case anyCanceled:
			task.Status = "canceled"
		default:
			task.Status = "success"
		}

		if len(errorParts) > 0 {
			task.ErrorSummary = strings.Join(errorParts, "; ")
		} else {
			task.ErrorSummary = ""
		}

		h.saveTask(task)
		h.broadcastTaskEvent(TaskEvent{Type: "task_update", TaskID: task.ID, Status: task.Status, CancelRequested: task.CancelRequested})

		if task.Status == "success" {
			h.logTask(task, "Sync completed successfully")
			h.hub.Broadcast(fmt.Sprintf("TASK_SUCCESS:%s", task.ID))
			return
		}
		if task.Status == "canceled" {
			h.logTask(task, "Sync canceled")
			h.hub.Broadcast(fmt.Sprintf("TASK_FAILED:%s:%s", task.ID, "canceled"))
			return
		}
		h.hub.Broadcast(fmt.Sprintf("TASK_FAILED:%s:%s", task.ID, "failed"))
	})
}

func (h *Handler) runSingleTargetSync(
	ctx context.Context,
	cancel context.CancelFunc,
	task *SyncTask,
	targetIdx int,
	srcAuth *vault.Credential,
	creds []vault.Credential,
	apply func(func()),
) {
	targetCtx := ctx
	targetCancel := func() {}
	if task.TimeoutSeconds > 0 {
		targetCtx, targetCancel = context.WithTimeout(ctx, time.Duration(task.TimeoutSeconds)*time.Second)
	}
	defer targetCancel()

	isCanceledError := func(err error) bool {
		if err == nil {
			return false
		}
		if errors.Is(err, context.Canceled) {
			return true
		}
		msg := strings.ToLower(err.Error())
		return strings.Contains(msg, "context canceled") || strings.Contains(msg, "request canceled")
	}

	isCanceledByRequest := func(err error) bool {
		if !isCanceledError(err) {
			return false
		}
		if task.CancelRequested {
			return true
		}
		if ctx.Err() != nil {
			return true
		}
		return targetCtx.Err() != nil
	}

	getTargetAuth := func(id string) *vault.Credential {
		return findCredentialByID(creds, id)
	}

	apply(func() {
		now := time.Now()
		task.Targets[targetIdx].Status = "running"
		task.Targets[targetIdx].StartedAt = &now
		task.Targets[targetIdx].Progress = 0.05
		task.Targets[targetIdx].Attempts = 0
		h.saveTask(task)
		h.broadcastTaskEvent(TaskEvent{
			Type:         "target_update",
			TaskID:       task.ID,
			TargetRef:    task.Targets[targetIdx].TargetRef,
			TargetStatus: task.Targets[targetIdx].Status,
			Progress:     task.Targets[targetIdx].Progress,
			Attempts:     task.Targets[targetIdx].Attempts,
		})
		h.logTask(task, fmt.Sprintf("Target %s: starting", task.Targets[targetIdx].TargetRef))
	})

	for attempt := 0; attempt <= task.MaxRetries; attempt++ {
		if ctx.Err() != nil {
			apply(func() {
				now := time.Now()
				task.Targets[targetIdx].Status = "canceled"
				task.Targets[targetIdx].EndedAt = &now
				task.Targets[targetIdx].Progress = 0
				task.Targets[targetIdx].Error = "canceled"
				h.saveTask(task)
				h.broadcastTaskEvent(TaskEvent{
					Type:         "target_update",
					TaskID:       task.ID,
					TargetRef:    task.Targets[targetIdx].TargetRef,
					TargetStatus: task.Targets[targetIdx].Status,
					Progress:     task.Targets[targetIdx].Progress,
					Attempts:     task.Targets[targetIdx].Attempts,
					Error:        task.Targets[targetIdx].Error,
				})
				h.logTask(task, fmt.Sprintf("Target %s: canceled", task.Targets[targetIdx].TargetRef))
			})
			return
		}

		apply(func() {
			task.Targets[targetIdx].Attempts = attempt + 1
			task.Targets[targetIdx].Progress = 0.1
			task.Targets[targetIdx].Error = ""
			h.saveTask(task)
			h.broadcastTaskEvent(TaskEvent{
				Type:         "target_update",
				TaskID:       task.ID,
				TargetRef:    task.Targets[targetIdx].TargetRef,
				TargetStatus: task.Targets[targetIdx].Status,
				Progress:     task.Targets[targetIdx].Progress,
				Attempts:     task.Targets[targetIdx].Attempts,
			})
			if attempt > 0 {
				h.logTask(task, fmt.Sprintf("Target %s: retry attempt %d", task.Targets[targetIdx].TargetRef, attempt+1))
			}
		})

		progress := make(chan engine.Progress, 32)
		runner := h.syncerFactory(targetCtx, progress)
		done := make(chan struct{})
		go func(targetRef string) {
			defer close(done)
			for p := range progress {
				msg := fmt.Sprintf("[TARGET %s] [%s] %s", targetRef, p.Level, p.Message)
				apply(func() {
					h.logTask(task, msg)
					if p.Phase != "" || p.Percent > 0 {
						if p.Percent > task.Targets[targetIdx].Progress {
							task.Targets[targetIdx].Progress = p.Percent
						}
						h.saveTask(task)
						h.broadcastTaskEvent(TaskEvent{
							Type:         "target_update",
							TaskID:       task.ID,
							TargetRef:    task.Targets[targetIdx].TargetRef,
							TargetStatus: task.Targets[targetIdx].Status,
							Progress:     task.Targets[targetIdx].Progress,
							Attempts:     task.Targets[targetIdx].Attempts,
						})
					}
				})
			}
		}(task.Targets[targetIdx].TargetRef)

		layoutPath, _ := h.resolveArchiveRef(task.SourceRef)

		opts := engine.SyncOptions{
			SourceRef:        task.SourceRef,
			TargetRef:        task.Targets[targetIdx].TargetRef,
			SourceAuth:       srcAuth,
			TargetAuth:       getTargetAuth(task.Targets[targetIdx].TargetID),
			SourceLayoutPath: layoutPath,
		}

		err := runner.SyncManifestList(opts)
		close(progress)
		<-done

		if err == nil {
			apply(func() {
				now := time.Now()
				task.Targets[targetIdx].Status = "success"
				task.Targets[targetIdx].EndedAt = &now
				task.Targets[targetIdx].Progress = 1
				task.Targets[targetIdx].Error = ""
				h.saveTask(task)
				h.broadcastTaskEvent(TaskEvent{
					Type:         "target_update",
					TaskID:       task.ID,
					TargetRef:    task.Targets[targetIdx].TargetRef,
					TargetStatus: task.Targets[targetIdx].Status,
					Progress:     task.Targets[targetIdx].Progress,
					Attempts:     task.Targets[targetIdx].Attempts,
				})
				h.logTask(task, fmt.Sprintf("Target %s: success", task.Targets[targetIdx].TargetRef))
			})
			return
		}

		if isCanceledByRequest(err) {
			apply(func() {
				now := time.Now()
				task.Targets[targetIdx].Status = "canceled"
				task.Targets[targetIdx].EndedAt = &now
				task.Targets[targetIdx].Progress = 0
				task.Targets[targetIdx].Error = err.Error()
				h.saveTask(task)
				h.broadcastTaskEvent(TaskEvent{
					Type:         "target_update",
					TaskID:       task.ID,
					TargetRef:    task.Targets[targetIdx].TargetRef,
					TargetStatus: task.Targets[targetIdx].Status,
					Progress:     task.Targets[targetIdx].Progress,
					Attempts:     task.Targets[targetIdx].Attempts,
					Error:        task.Targets[targetIdx].Error,
				})
				h.logTask(task, fmt.Sprintf("Target %s: canceled (%v)", task.Targets[targetIdx].TargetRef, err))
			})
			return
		}

		retryable := isRetryableError(err) || isCanceledError(err)
		if attempt < task.MaxRetries && retryable && !task.CancelRequested {
			backoff := time.Duration(500*(1<<attempt)) * time.Millisecond
			if backoff > 5*time.Second {
				backoff = 5 * time.Second
			}
			apply(func() {
				task.Targets[targetIdx].Error = err.Error()
				task.Targets[targetIdx].Progress = 0.1
				h.saveTask(task)
				h.broadcastTaskEvent(TaskEvent{
					Type:         "target_update",
					TaskID:       task.ID,
					TargetRef:    task.Targets[targetIdx].TargetRef,
					TargetStatus: task.Targets[targetIdx].Status,
					Progress:     task.Targets[targetIdx].Progress,
					Attempts:     task.Targets[targetIdx].Attempts,
					Error:        task.Targets[targetIdx].Error,
				})
				h.logTask(task, fmt.Sprintf("Target %s: retryable error (%v), backing off %s", task.Targets[targetIdx].TargetRef, err, backoff))
			})

			select {
			case <-time.After(backoff):
				continue
			case <-ctx.Done():
				continue
			}
		}

		apply(func() {
			now := time.Now()
			task.Targets[targetIdx].Status = "failed"
			task.Targets[targetIdx].EndedAt = &now
			task.Targets[targetIdx].Progress = 0
			task.Targets[targetIdx].Error = err.Error()
			h.saveTask(task)
			h.broadcastTaskEvent(TaskEvent{
				Type:         "target_update",
				TaskID:       task.ID,
				TargetRef:    task.Targets[targetIdx].TargetRef,
				TargetStatus: task.Targets[targetIdx].Status,
				Progress:     task.Targets[targetIdx].Progress,
				Attempts:     task.Targets[targetIdx].Attempts,
				Error:        task.Targets[targetIdx].Error,
			})
			h.logTask(task, fmt.Sprintf("Target %s: failed (%v)", task.Targets[targetIdx].TargetRef, err))
		})

		if task.FailFast && cancel != nil && !task.CancelRequested && !isCanceledError(err) {
			apply(func() {
				task.CancelRequested = true
				h.saveTask(task)
				h.broadcastTaskEvent(TaskEvent{Type: "task_update", TaskID: task.ID, Status: task.Status, CancelRequested: true})
				h.logTask(task, "Fail-fast: canceling remaining targets")
			})
			cancel()
		}
		return
	}
}

func isRetryableError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "timeout"):
		return true
	case strings.Contains(msg, "deadline exceeded"):
		return true
	case strings.Contains(msg, "i/o timeout"):
		return true
	case strings.Contains(msg, "connection reset"):
		return true
	case strings.Contains(msg, "connection refused"):
		return true
	case strings.Contains(msg, "temporary"):
		return true
	case strings.Contains(msg, "tls handshake timeout"):
		return true
	case strings.Contains(msg, "unexpected eof"):
		return true
	case strings.Contains(msg, "eof"):
		return true
	case strings.Contains(msg, "dial tcp"):
		return true
	default:
		return false
	}
}

func (h *Handler) resolveArchiveRef(ref string) (string, error) {
	if !strings.HasPrefix(ref, "archive://") {
		return "", nil
	}
	id := strings.TrimPrefix(ref, "archive://")

	// Ensure metadata is loaded
	if err := h.loadArchivesMeta(); err != nil {
		return "", err
	}

	archivesMu.Lock()
	defer archivesMu.Unlock()

	for _, m := range archivesMeta {
		if m.ID == id {
			return m.Path, nil
		}
	}

	return "", fmt.Errorf("archive not found: %s", id)
}

func getDirSize(path string) (int64, error) {
	var size int64
	err := filepath.Walk(path, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if !info.IsDir() {
			size += info.Size()
		}
		return nil
	})
	return size, err
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.2f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
