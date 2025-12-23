package engine

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
	"github.com/guoxudong/horcrux/internal/vault"
)

// SyncOptions defines the options for a synchronization task
type SyncOptions struct {
	SourceRef   string
	TargetRef   string
	SourceAuth  *vault.Credential
	TargetAuth  *vault.Credential
	Incremental bool
	Concurrency int
}

// Progress defines a progress update from the syncer
type Progress struct {
	Message string
	Level   string // INFO, SYNC, ERROR, SUCCESS
	Phase   string
	Percent float64
}

// Syncer handles image synchronization
type Syncer struct {
	ctx       context.Context
	progress  chan<- Progress
	transport http.RoundTripper
}

func NewSyncer(progress chan<- Progress) *Syncer {
	return &Syncer{
		ctx:       context.Background(),
		progress:  progress,
		transport: newHTTPTransport(),
	}
}

func NewSyncerWithContext(ctx context.Context, progress chan<- Progress) *Syncer {
	if ctx == nil {
		ctx = context.Background()
	}
	return &Syncer{
		ctx:       ctx,
		progress:  progress,
		transport: newHTTPTransport(),
	}
}

func (s *Syncer) log(level, msg string) {
	if s.progress != nil {
		s.progress <- Progress{Message: msg, Level: level}
	}
	log.Printf("[%s] %s", level, msg)
}

func (s *Syncer) logProgress(level, msg, phase string, percent float64) {
	if s.progress != nil {
		s.progress <- Progress{Message: msg, Level: level, Phase: phase, Percent: percent}
	}
	log.Printf("[%s] %s", level, msg)
}

func newHTTPTransport() http.RoundTripper {
	defaultTransport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return http.DefaultTransport
	}

	t := defaultTransport.Clone()
	dialer := &net.Dialer{
		Timeout:   30 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	t.DialContext = dialer.DialContext
	t.MaxIdleConns = 100
	t.MaxIdleConnsPerHost = 20
	t.IdleConnTimeout = 90 * time.Second
	t.TLSHandshakeTimeout = 10 * time.Second
	t.ExpectContinueTimeout = 1 * time.Second
	t.ResponseHeaderTimeout = 30 * time.Second
	return t
}

func (s *Syncer) remoteOptions(ctx context.Context, auth authn.Authenticator) []remote.Option {
	backoff := remote.Backoff{
		Duration: 500 * time.Millisecond,
		Factor:   2,
		Jitter:   0.1,
		Steps:    7,
		Cap:      10 * time.Second,
	}

	return []remote.Option{
		remote.WithAuth(auth),
		remote.WithContext(ctx),
		remote.WithTransport(s.transport),
		remote.WithRetryBackoff(backoff),
		remote.WithRetryPredicate(shouldRetryRemoteError),
		remote.WithRetryStatusCodes(
			http.StatusTooManyRequests,
			http.StatusInternalServerError,
			http.StatusBadGateway,
			http.StatusServiceUnavailable,
			http.StatusGatewayTimeout,
		),
	}
}

func shouldRetryRemoteError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}

	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	var temporary interface{ Temporary() bool }
	if errors.As(err, &temporary) && temporary.Temporary() {
		return true
	}

	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "unauthorized") ||
		strings.Contains(msg, "forbidden") ||
		strings.Contains(msg, "denied") ||
		strings.Contains(msg, "invalid username") ||
		strings.Contains(msg, "incorrect username") ||
		strings.Contains(msg, "password") {
		return false
	}

	retryMarkers := []string{
		"i/o timeout",
		"timeout",
		"connection reset",
		"broken pipe",
		"unexpected eof",
		"eof",
		"context canceled",
		"request canceled",
		"stream error",
		"internal_error",
		"http2",
		"server closed idle connection",
		"connection refused",
	}
	for _, marker := range retryMarkers {
		if strings.Contains(msg, marker) {
			return true
		}
	}

	return false
}

func (s *Syncer) newUploadProgressReporter(phase string, base, span float64) (chan v1.Update, func()) {
	updates := make(chan v1.Update, 1024)
	done := make(chan struct{})

	go func() {
		defer close(done)
		var lastLogged time.Time
		lastPercent := -1.0

		for u := range updates {
			var percent float64
			if u.Total > 0 {
				frac := float64(u.Complete) / float64(u.Total)
				if frac < 0 {
					frac = 0
				}
				if frac > 1 {
					frac = 1
				}
				percent = base + span*frac
			} else {
				percent = base
			}

			if percent < base {
				percent = base
			}
			if percent > base+span {
				percent = base + span
			}
			if percent <= lastPercent {
				continue
			}

			now := time.Now()
			if !lastLogged.IsZero() && now.Sub(lastLogged) < 800*time.Millisecond && percent-lastPercent < 0.02 {
				continue
			}

			lastLogged = now
			lastPercent = percent
			s.logProgress("SYNC", fmt.Sprintf("Uploading... %s/%s", formatBytes(u.Complete), formatBytes(u.Total)), phase, percent)
		}
	}()

	return updates, func() {
		select {
		case <-done:
			return
		case <-time.After(2 * time.Second):
			return
		}
	}
}

func (s *Syncer) uploadProgressOption(phase string, base, span float64) (remote.Option, func()) {
	updates, closeFn := s.newUploadProgressReporter(phase, base, span)
	return remote.WithProgress(updates), closeFn
}

func formatBytes(v int64) string {
	if v <= 0 {
		return "0B"
	}

	const (
		kb = 1024
		mb = 1024 * 1024
		gb = 1024 * 1024 * 1024
	)

	switch {
	case v >= gb:
		return fmt.Sprintf("%.2fGB", float64(v)/float64(gb))
	case v >= mb:
		return fmt.Sprintf("%.2fMB", float64(v)/float64(mb))
	case v >= kb:
		return fmt.Sprintf("%.2fKB", float64(v)/float64(kb))
	default:
		return fmt.Sprintf("%dB", v)
	}
}

// getAuth returns an authn.Authenticator for a given vault credential
func (s *Syncer) getAuth(cred *vault.Credential) authn.Authenticator {
	if cred == nil || cred.Username == "" {
		s.log("INFO", "Using anonymous authentication")
		return authn.Anonymous
	}

	// 特殊处理 Docker Hub: 如果 registry 为空或者为 docker.io，则视为 Docker Hub
	// authn.Basic 对于 docker.io 是有效的，但 go-containerregistry
	// 在处理 docker.io 时，内部会自动将其映射到 index.docker.io/v1/
	s.log("INFO", fmt.Sprintf("Using basic authentication for user: %s", cred.Username))
	return &authn.Basic{
		Username: cred.Username,
		Password: cred.Password,
	}
}

// SyncImage synchronizes an image from source to target
func (s *Syncer) SyncImage(opts SyncOptions) error {
	src, err := name.ParseReference(opts.SourceRef)
	if err != nil {
		return fmt.Errorf("failed to parse source reference: %v", err)
	}

	dst, err := name.ParseReference(opts.TargetRef)
	if err != nil {
		return fmt.Errorf("failed to parse target reference: %v", err)
	}

	s.logProgress("SYNC", fmt.Sprintf("Syncing %s to %s...", opts.SourceRef, opts.TargetRef), "start", 0.15)

	// Fetch the source image
	s.logProgress("SYNC", "Fetching source image...", "fetch_source", 0.35)
	img, err := remote.Image(src, s.remoteOptions(s.ctx, s.getAuth(opts.SourceAuth))...)
	if err != nil {
		return fmt.Errorf("failed to fetch source image: %w", err)
	}

	// Push the image to the target
	s.logProgress("SYNC", "Pushing image to target...", "push_target", 0.75)
	uploadOpt, closeUpload := s.uploadProgressOption("push_target", 0.75, 0.2)
	err = remote.Write(dst, img, append(s.remoteOptions(s.ctx, s.getAuth(opts.TargetAuth)), uploadOpt)...)
	closeUpload()
	if err != nil {
		return fmt.Errorf("failed to push image to target: %w", err)
	}

	s.logProgress("SUCCESS", fmt.Sprintf("Successfully synced %s to %s", opts.SourceRef, opts.TargetRef), "done", 1)
	return nil
}

// SyncTarball pushes a local docker tarball to a remote registry
func (s *Syncer) SyncTarball(tarPath string, targetRef string, targetAuth *vault.Credential) error {
	dst, err := name.ParseReference(targetRef)
	if err != nil {
		return fmt.Errorf("failed to parse target reference: %v", err)
	}

	img, err := tarball.ImageFromPath(tarPath, nil)
	if err != nil {
		return fmt.Errorf("failed to load image from tarball %s: %v", tarPath, err)
	}

	uploadOpt, closeUpload := s.uploadProgressOption("push_target", 0.75, 0.2)
	err = remote.Write(dst, img, append(s.remoteOptions(s.ctx, s.getAuth(targetAuth)), uploadOpt)...)
	closeUpload()
	if err != nil {
		return fmt.Errorf("failed to push tarball image to target: %v", err)
	}

	return nil
}

// MergeManifests merges multiple source images into a single multi-arch manifest
func (s *Syncer) MergeManifests(sourceRefs []string, targetRef string, srcAuths []*vault.Credential, targetAuth *vault.Credential) error {
	dst, err := name.ParseReference(targetRef)
	if err != nil {
		return fmt.Errorf("failed to parse target reference: %v", err)
	}

	var adds []mutate.IndexAddendum

	for i, refStr := range sourceRefs {
		ref, parseErr := name.ParseReference(refStr)
		if parseErr != nil {
			return fmt.Errorf("failed to parse source reference %s: %w", refStr, parseErr)
		}

		var auth authn.Authenticator = authn.Anonymous
		if i < len(srcAuths) && srcAuths[i] != nil {
			auth = s.getAuth(srcAuths[i])
		}

		img, fetchErr := remote.Image(ref, s.remoteOptions(s.ctx, auth)...)
		if fetchErr != nil {
			return fmt.Errorf("failed to fetch image %s: %w", refStr, fetchErr)
		}

		descriptor, descErr := remote.Get(ref, s.remoteOptions(s.ctx, auth)...)
		if descErr != nil {
			return fmt.Errorf("failed to get descriptor for %s: %w", refStr, descErr)
		}

		adds = append(adds, mutate.IndexAddendum{
			Add:        img,
			Descriptor: descriptor.Descriptor,
		})
	}

	idx := mutate.AppendManifests(empty.Index, adds...)

	uploadOpt, closeUpload := s.uploadProgressOption("push_target", 0.75, 0.2)
	err = remote.WriteIndex(dst, idx, append(s.remoteOptions(s.ctx, s.getAuth(targetAuth)), uploadOpt)...)
	closeUpload()
	if err != nil {
		return fmt.Errorf("failed to push merged manifest: %w", err)
	}

	return nil
}

// SyncManifestList synchronizes a manifest list (multi-arch image)
func (s *Syncer) SyncManifestList(opts SyncOptions) error {
	src, err := name.ParseReference(opts.SourceRef)
	if err != nil {
		return fmt.Errorf("failed to parse source reference: %v", err)
	}

	dst, err := name.ParseReference(opts.TargetRef)
	if err != nil {
		return fmt.Errorf("failed to parse target reference: %v", err)
	}

	s.logProgress("SYNC", fmt.Sprintf("Syncing manifest list %s to %s...", opts.SourceRef, opts.TargetRef), "start", 0.15)

	s.logProgress("SYNC", "Fetching source manifest list...", "fetch_source", 0.35)
	idx, err := remote.Index(src, s.remoteOptions(s.ctx, s.getAuth(opts.SourceAuth))...)
	if err != nil {
		// If it's not an index, try syncing as a regular image
		return s.SyncImage(opts)
	}

	s.logProgress("SYNC", "Pushing manifest list to target...", "push_target", 0.75)
	uploadOpt, closeUpload := s.uploadProgressOption("push_target", 0.75, 0.2)
	err = remote.WriteIndex(dst, idx, append(s.remoteOptions(s.ctx, s.getAuth(opts.TargetAuth)), uploadOpt)...)
	closeUpload()
	if err != nil {
		return fmt.Errorf("failed to push manifest list to target: %w", err)
	}

	s.logProgress("SUCCESS", "Manifest list synced successfully", "done", 1)
	return nil
}

// VerifyAuth checks if the provided credentials are valid for the registry
func (s *Syncer) VerifyAuth(registry string, cred *vault.Credential) error {
	ctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
	defer cancel()

	// 规范化 Registry 名称
	if registry == "docker.io" {
		registry = "index.docker.io"
	}

	reg, err := name.NewRegistry(registry)
	if err != nil {
		return fmt.Errorf("invalid registry URL: %v", err)
	}

	auth := s.getAuth(cred)

	// 方法 1: 使用标准的 /v2/ 接口进行 Ping 测试
	scheme := "https"
	url := fmt.Sprintf("%s://%s/v2/", scheme, reg.Name())
	log.Printf("[DEBUG] Verifying auth for registry: %s, URL: %s", registry, url)

	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.SetBasicAuth(cred.Username, cred.Password)
	// 阿里云 ACR 必须明确设置 User-Agent 和 Accept，否则可能直接 401
	req.Header.Set("User-Agent", "docker/27.0.3 go/go1.24.2 git-commit/7d424b3 kernel/6.10.4-linuxkit os/linux arch/arm64 UpstreamClient(Docker-Client/27.0.3 (linux))")
	req.Header.Set("Accept", "application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/json")

	client := &http.Client{}

	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[DEBUG] Ping /v2/ failed with error: %v", err)
	} else {
		defer resp.Body.Close()
		log.Printf("[DEBUG] Ping /v2/ returned status: %s", resp.Status)

		// 阿里云 ACR 认证逻辑：
		// 1. 如果返回 200 OK，认证成功
		// 2. 如果返回 401，说明认证失败（或者需要 Bearer 认证，但 ACR 支持 Basic）
		// 3. 如果返回 403/404，说明认证通过但没有路径权限
		if resp.StatusCode == http.StatusOK {
			log.Printf("[DEBUG] Auth success via /v2/ (200 OK)")
			return nil
		}

		// 特殊处理阿里云：ACR 的 /v2/ 接口有时即使认证通过也会返回 401，要求挑战 Bearer Token
		// 此时我们需要检查 Www-Authenticate 头
		authHeader := resp.Header.Get("Www-Authenticate")
		if resp.StatusCode == http.StatusUnauthorized && strings.Contains(authHeader, "Bearer") {
			log.Printf("[DEBUG] /v2/ returned 401 with Bearer challenge, attempting token fetch")
			// 如果有 Bearer 挑战，说明用户名密码可能被接受了，只是需要进一步获取 Token
			// 对于验证目的，能拿到 Bearer 挑战通常意味着 Basic 认证初步通过
			// 但为了保险，我们继续走方法 2
		} else if resp.StatusCode == http.StatusUnauthorized {
			log.Printf("[DEBUG] Auth failed via /v2/ (401 Unauthorized - No Bearer challenge)")
		} else if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound {
			log.Printf("[DEBUG] Auth likely success via /v2/ (Status: %d)", resp.StatusCode)
			return nil
		}
	}

	log.Printf("[DEBUG] Falling back to Method 2 (List Repository)")

	// 方法 2: 备选方案，尝试 List 仓库（旧逻辑）
	// 对于某些不完全遵守 /v2/ 规范或需要特定 scope 的镜像站
	repo, err := name.NewRepository(registry + "/kwdb/kwdb")
	if err != nil {
		repo, err = name.NewRepository(registry + "/ping-test")
		if err != nil {
			return err
		}
	}

	_, err = remote.List(repo, s.remoteOptions(ctx, auth)...)
	if err != nil {
		log.Printf("[DEBUG] List repository failed: %v", err)
		errMsg := strings.ToLower(err.Error())
		if strings.Contains(errMsg, "unauthorized") || strings.Contains(errMsg, "forbidden") {
			return fmt.Errorf("authentication failed: %v", err)
		}

		// 如果是 "not found"，说明认证可能已经成功（能走到 404 说明已经过了认证阶段）
		if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "name_unknown") {
			log.Printf("[DEBUG] Auth success via List (Not Found / Name Unknown)")
			return nil
		}

		return err
	}

	log.Printf("[DEBUG] Auth success via List (Repository found)")
	return nil
}
