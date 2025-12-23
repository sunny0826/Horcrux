package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/guoxudong/horcrux/internal/engine"
	"github.com/guoxudong/horcrux/internal/vault"
	"github.com/stretchr/testify/assert"
)

type fakeSyncerRunner struct {
	ctx       context.Context
	progress  chan<- engine.Progress
	behaviors *fakeSyncerBehaviors
}

type fakeSyncerBehaviors struct {
	mu                 sync.Mutex
	errorsByTargetRef  map[string][]error
	delay              time.Duration
	delayByTargetRef   map[string]time.Duration
	blockUntilCanceled bool
	currentConcurrent  atomic.Int64
	maxConcurrent      atomic.Int64
}

func (r *fakeSyncerRunner) SyncManifestList(opts engine.SyncOptions) error {
	if r.behaviors != nil {
		now := r.behaviors.currentConcurrent.Add(1)
		for {
			prev := r.behaviors.maxConcurrent.Load()
			if now <= prev {
				break
			}
			if r.behaviors.maxConcurrent.CompareAndSwap(prev, now) {
				break
			}
		}
		defer r.behaviors.currentConcurrent.Add(-1)
	}

	if r.progress != nil {
		r.progress <- engine.Progress{Level: "SYNC", Message: "start", Phase: "start", Percent: 0.2}
	}

	if r.behaviors != nil && r.behaviors.blockUntilCanceled {
		select {
		case <-r.ctx.Done():
			return r.ctx.Err()
		case <-time.After(3 * time.Second):
			return nil
		}
	}

	if r.behaviors != nil && (r.behaviors.delay > 0 || len(r.behaviors.delayByTargetRef) > 0) {
		delay := r.behaviors.delay
		if r.behaviors.delayByTargetRef != nil {
			if d, ok := r.behaviors.delayByTargetRef[opts.TargetRef]; ok {
				delay = d
			}
		}
		if delay <= 0 {
			goto afterDelay
		}
		select {
		case <-time.After(delay):
		case <-r.ctx.Done():
			return r.ctx.Err()
		}
	}
afterDelay:

	if r.progress != nil {
		r.progress <- engine.Progress{Level: "SYNC", Message: "pushing", Phase: "push_target", Percent: 0.8}
	}

	var outErr error
	if r.behaviors != nil {
		r.behaviors.mu.Lock()
		if seq, ok := r.behaviors.errorsByTargetRef[opts.TargetRef]; ok && len(seq) > 0 {
			outErr = seq[0]
			r.behaviors.errorsByTargetRef[opts.TargetRef] = seq[1:]
		}
		r.behaviors.mu.Unlock()
	}

	if outErr != nil {
		return outErr
	}

	if r.progress != nil {
		r.progress <- engine.Progress{Level: "SUCCESS", Message: "done", Phase: "done", Percent: 1}
	}
	return nil
}

func waitTaskDone(t *testing.T, h *Handler, id string, timeout time.Duration) *SyncTask {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		task, err := h.loadTask(id)
		if err == nil && task != nil && task.Status != "running" {
			return task
		}
		time.Sleep(20 * time.Millisecond)
	}
	task, _ := h.loadTask(id)
	t.Fatalf("task %s not completed, last=%+v", id, task)
	return nil
}

func TestListTasks(t *testing.T) {
	// Setup
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	// Create a dummy task
	tasksDir := filepath.Join(tempDir, "tasks")
	err = os.MkdirAll(tasksDir, 0755)
	assert.NoError(t, err)

	task := SyncTask{
		ID:        "test-task-1",
		SourceRef: "src:latest",
		TargetRef: "dst:latest",
		Status:    "success",
		CreatedAt: time.Now(),
	}
	taskData, _ := json.Marshal(task)
	err = os.WriteFile(filepath.Join(tasksDir, "test-task-1.json"), taskData, 0644)
	assert.NoError(t, err)

	// Create router and request
	r := gin.Default()
	r.GET("/api/tasks", h.ListTasks)

	req, _ := http.NewRequest("GET", "/api/tasks", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	// Assertions
	assert.Equal(t, http.StatusOK, w.Code)

	var response map[string][]SyncTask
	err = json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)
	assert.Len(t, response["tasks"], 1)
	assert.Equal(t, "test-task-1", response["tasks"][0].ID)
}

func TestTaskPersistence(t *testing.T) {
	// Setup
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-persistence-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	vaultPath := filepath.Join(tempDir, "vault.enc")
	key := "12345678901234567890123456789012"

	// 1. Create a task with one handler instance
	v1, _ := vault.NewVault(vaultPath, key)
	h1 := NewHandler(v1, NewHub())

	task := &SyncTask{
		ID:        "persistent-task",
		SourceRef: "src",
		TargetRef: "dst",
		Status:    "success",
		CreatedAt: time.Now(),
	}
	h1.saveTask(task)

	// 2. Simulate restart by creating a new handler with the same storage path
	v2, _ := vault.NewVault(vaultPath, key)
	h2 := NewHandler(v2, NewHub())

	r := gin.Default()
	r.GET("/api/tasks", h2.ListTasks)

	req, _ := http.NewRequest("GET", "/api/tasks", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	// Assertions
	assert.Equal(t, http.StatusOK, w.Code)
	var response map[string][]SyncTask
	json.Unmarshal(w.Body.Bytes(), &response)

	assert.Len(t, response["tasks"], 1)
	assert.Equal(t, "persistent-task", response["tasks"][0].ID)
}

func TestTaskCompatConversionWritesBack(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-compat-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	id := "legacy-task-1"
	createdAt := time.Now().Add(-2 * time.Minute).UTC().Format(time.RFC3339Nano)
	legacy := map[string]any{
		"id":        id,
		"mode":      "batch",
		"sourceRef": "src:legacy",
		"targets": []any{
			map[string]any{
				"targetRef": "dst:legacy",
				"status":    "completed",
			},
		},
		"status":    "completed",
		"createdAt": createdAt,
		"logs":      []any{"hello", map[string]any{"time": createdAt, "level": "INFO", "message": "world"}},
	}

	tasksDir := filepath.Join(tempDir, "tasks")
	assert.NoError(t, os.MkdirAll(tasksDir, 0755))
	b, _ := json.Marshal(legacy)
	assert.NoError(t, os.WriteFile(filepath.Join(tasksDir, id+".json"), b, 0644))

	r := gin.Default()
	r.GET("/api/tasks", h.ListTasks)

	req, _ := http.NewRequest("GET", "/api/tasks", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var resp struct {
		Tasks []SyncTask `json:"tasks"`
	}
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.Len(t, resp.Tasks, 1)
	assert.Equal(t, id, resp.Tasks[0].ID)

	convertedBytes, err := os.ReadFile(filepath.Join(tasksDir, id+".json"))
	assert.NoError(t, err)
	var converted SyncTask
	assert.NoError(t, json.Unmarshal(convertedBytes, &converted))
	assert.Equal(t, id, converted.ID)
	assert.Equal(t, "src:legacy", converted.SourceRef)
	assert.Equal(t, "dst:legacy", converted.TargetRef)
	assert.Equal(t, "success", converted.Status)
	assert.False(t, converted.CreatedAt.IsZero())
	assert.NotNil(t, converted.Logs)
	assert.GreaterOrEqual(t, len(converted.Logs), 2)
}

func TestGetTask_CompatWrappedResponseAccepted(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-compat-get-task-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	id := "legacy-task-2"
	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	legacy := map[string]any{
		"id":        id,
		"sourceRef": "src:legacy",
		"targetRef": "dst:legacy",
		"status":    "completed",
		"createdAt": createdAt,
		"logs":      "line1\nline2",
	}

	tasksDir := filepath.Join(tempDir, "tasks")
	assert.NoError(t, os.MkdirAll(tasksDir, 0755))
	b, _ := json.Marshal(legacy)
	assert.NoError(t, os.WriteFile(filepath.Join(tasksDir, id+".json"), b, 0644))

	r := gin.Default()
	r.GET("/api/tasks/:id", h.GetTask)

	req, _ := http.NewRequest("GET", "/api/tasks/"+id, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)

	var direct SyncTask
	if err := json.Unmarshal(w.Body.Bytes(), &direct); err == nil && direct.ID != "" {
		assert.Equal(t, id, direct.ID)
		return
	}

	var wrapped struct {
		Task *SyncTask `json:"task"`
	}
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &wrapped))
	assert.NotNil(t, wrapped.Task)
	assert.Equal(t, id, wrapped.Task.ID)
}

func TestExecuteSync_MultiTargetSuccess(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef: map[string][]error{},
		delay:             60 * time.Millisecond,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)

	reqBody := SyncRequest{
		SourceRef: "src:latest",
		SourceID:  "",
		Targets: []SyncTargetRequest{
			{TargetRef: "dst-a:latest", TargetID: ""},
			{TargetRef: "dst-b:latest", TargetID: ""},
		},
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	task := waitTaskDone(t, h, created.ID, 3*time.Second)

	assert.Equal(t, "success", task.Status)
	assert.Len(t, task.Targets, 2)
	for _, ts := range task.Targets {
		assert.Equal(t, "success", ts.Status)
		assert.Equal(t, float64(1), ts.Progress)
	}
	assert.Equal(t, int64(2), behaviors.maxConcurrent.Load())
}

func TestExecuteSync_SameTargetRefDifferentRegistries(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-dedup-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	assert.NoError(t, v.SaveCredentials([]vault.Credential{
		{ID: "cred-src", Registry: "docker.io", Username: "u", Password: "p"},
		{ID: "cred-aliyun", Registry: "registry.cn-hangzhou.aliyuncs.com", Username: "u", Password: "p"},
		{ID: "cred-ghcr", Registry: "ghcr.io", Username: "u", Password: "p"},
	}))

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef: map[string][]error{},
		delay:             10 * time.Millisecond,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)

	reqBody := SyncRequest{
		SourceRef: "kwdb/smart-meter",
		SourceID:  "cred-src",
		Targets: []SyncTargetRequest{
			{TargetRef: "kwdb/smart-meter", TargetID: "cred-aliyun"},
			{TargetRef: "kwdb/smart-meter", TargetID: "cred-ghcr"},
		},
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	task := waitTaskDone(t, h, created.ID, 3*time.Second)

	assert.Equal(t, "success", task.Status)
	assert.Len(t, task.Targets, 2)
	refs := map[string]bool{}
	for _, ts := range task.Targets {
		refs[ts.TargetRef] = true
	}
	assert.True(t, refs["registry.cn-hangzhou.aliyuncs.com/kwdb/smart-meter"])
	assert.True(t, refs["ghcr.io/kwdb/smart-meter"])
}

func TestExecuteSync_OneTargetFails_NoFailFast(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-fail-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef: map[string][]error{
			"dst-b:latest": {errors.New("unauthorized")},
		},
		delay: 20 * time.Millisecond,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)

	failFast := false
	maxRetries := 0
	concurrency := 2
	reqBody := SyncRequest{
		SourceRef:   "src:latest",
		Targets:     []SyncTargetRequest{{TargetRef: "dst-a:latest"}, {TargetRef: "dst-b:latest"}},
		FailFast:    &failFast,
		MaxRetries:  &maxRetries,
		Concurrency: &concurrency,
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	task := waitTaskDone(t, h, created.ID, 3*time.Second)

	assert.Equal(t, "failed", task.Status)
	assert.Len(t, task.Targets, 2)
	m := map[string]TargetSyncState{}
	for _, ts := range task.Targets {
		m[ts.TargetRef] = ts
	}
	assert.Equal(t, "success", m["dst-a:latest"].Status)
	assert.Equal(t, "failed", m["dst-b:latest"].Status)
	assert.NotEmpty(t, task.ErrorSummary)
}

func TestExecuteSync_MultiTargetDefaultNoFailFast(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-default-failfast-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef: map[string][]error{
			"dst-b:latest": {errors.New("unauthorized")},
		},
		delay: 20 * time.Millisecond,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)

	reqBody := SyncRequest{
		SourceRef: "src:latest",
		Targets:   []SyncTargetRequest{{TargetRef: "dst-a:latest"}, {TargetRef: "dst-b:latest"}},
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	task := waitTaskDone(t, h, created.ID, 3*time.Second)

	assert.Equal(t, "failed", task.Status)
	assert.Len(t, task.Targets, 2)
	m := map[string]TargetSyncState{}
	for _, ts := range task.Targets {
		m[ts.TargetRef] = ts
	}
	assert.Equal(t, "success", m["dst-a:latest"].Status)
	assert.Equal(t, "failed", m["dst-b:latest"].Status)
}

func TestExecuteSync_FailFastCancelsOtherTargets(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-failfast-cancel-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef: map[string][]error{
			"dst-b:latest": {errors.New("unauthorized")},
		},
		delayByTargetRef: map[string]time.Duration{
			"dst-a:latest": 3 * time.Second,
			"dst-b:latest": 0,
		},
		delay: 0,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)

	failFast := true
	concurrency := 2
	maxRetries := 0
	reqBody := SyncRequest{
		SourceRef:   "src:latest",
		Targets:     []SyncTargetRequest{{TargetRef: "dst-a:latest"}, {TargetRef: "dst-b:latest"}},
		FailFast:    &failFast,
		Concurrency: &concurrency,
		MaxRetries:  &maxRetries,
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	task := waitTaskDone(t, h, created.ID, 4*time.Second)

	assert.Equal(t, "failed", task.Status)
	assert.True(t, task.CancelRequested)
	m := map[string]TargetSyncState{}
	for _, ts := range task.Targets {
		m[ts.TargetRef] = ts
	}
	assert.Equal(t, "failed", m["dst-b:latest"].Status)
	assert.Equal(t, "canceled", m["dst-a:latest"].Status)
}

func TestExecuteSync_RetryOnNetworkInterruption(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-retry-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef: map[string][]error{
			"dst-a:latest": {errors.New("i/o timeout"), nil},
		},
		delay: 10 * time.Millisecond,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)

	maxRetries := 1
	reqBody := SyncRequest{
		SourceRef:  "src:latest",
		Targets:    []SyncTargetRequest{{TargetRef: "dst-a:latest"}},
		MaxRetries: &maxRetries,
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	task := waitTaskDone(t, h, created.ID, 3*time.Second)

	assert.Equal(t, "success", task.Status)
	assert.Len(t, task.Targets, 1)
	assert.Equal(t, "success", task.Targets[0].Status)
	assert.Equal(t, 2, task.Targets[0].Attempts)
}

func TestCancelTask_CancelsRunningTargets(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-cancel-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef: map[string][]error{},
		delay:             2 * time.Second,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)
	tasks.POST("/:id/cancel", h.CancelTask)

	concurrency := 2
	reqBody := SyncRequest{
		SourceRef:   "src:latest",
		Targets:     []SyncTargetRequest{{TargetRef: "dst-a:latest"}, {TargetRef: "dst-b:latest"}},
		Concurrency: &concurrency,
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))

	cancelReq, _ := http.NewRequest("POST", "/api/tasks/"+created.ID+"/cancel", nil)
	cancelW := httptest.NewRecorder()
	r.ServeHTTP(cancelW, cancelReq)
	assert.Equal(t, http.StatusOK, cancelW.Code)

	task := waitTaskDone(t, h, created.ID, 5*time.Second)
	assert.Equal(t, "canceled", task.Status)
	for _, ts := range task.Targets {
		assert.Equal(t, "canceled", ts.Status)
	}
}

func TestExecuteSync_TargetTimeoutEndsTask(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-timeout-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef:  map[string][]error{},
		blockUntilCanceled: true,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)

	maxRetries := 0
	timeoutSeconds := 1
	reqBody := SyncRequest{
		SourceRef:      "src:latest",
		Targets:        []SyncTargetRequest{{TargetRef: "dst-a:latest"}},
		MaxRetries:     &maxRetries,
		TimeoutSeconds: &timeoutSeconds,
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	task := waitTaskDone(t, h, created.ID, 4*time.Second)

	assert.Equal(t, "failed", task.Status)
	assert.Len(t, task.Targets, 1)
	assert.Equal(t, "failed", task.Targets[0].Status)
	assert.NotEmpty(t, task.Targets[0].Error)
}

func TestExecuteSync_RetryOnContextCanceled(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-sync-context-canceled-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	hub := NewHub()
	go hub.Run()

	behaviors := &fakeSyncerBehaviors{
		errorsByTargetRef: map[string][]error{
			"dst-a:latest": {errors.New("context canceled"), nil},
		},
		delay: 10 * time.Millisecond,
	}

	h := NewHandlerWithSyncerFactory(v, hub, func(ctx context.Context, progress chan<- engine.Progress) syncerRunner {
		return &fakeSyncerRunner{ctx: ctx, progress: progress, behaviors: behaviors}
	})

	r := gin.Default()
	apiGroup := r.Group("/api")
	tasks := apiGroup.Group("/tasks")
	tasks.POST("/sync", h.ExecuteSync)

	maxRetries := 1
	reqBody := SyncRequest{
		SourceRef:  "src:latest",
		Targets:    []SyncTargetRequest{{TargetRef: "dst-a:latest"}},
		MaxRetries: &maxRetries,
	}
	b, _ := json.Marshal(reqBody)
	req, _ := http.NewRequest("POST", "/api/tasks/sync", bytes.NewBuffer(b))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	assert.Equal(t, http.StatusOK, w.Code)

	var created SyncTask
	assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &created))
	task := waitTaskDone(t, h, created.ID, 3*time.Second)

	assert.Equal(t, "success", task.Status)
	assert.Len(t, task.Targets, 1)
	assert.Equal(t, "success", task.Targets[0].Status)
	assert.Equal(t, 2, task.Targets[0].Attempts)
}

func TestPipeCRUDAndVersioning(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-pipes-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	r := gin.Default()
	apiGroup := r.Group("/api")
	pipes := apiGroup.Group("/pipes")
	pipes.POST("", h.SavePipe)
	pipes.GET("", h.ListPipes)
	pipes.GET("/:id", h.GetPipe)
	pipes.PUT("/:id", h.UpdatePipe)
	pipes.DELETE("/:id", h.DeletePipe)
	pipes.GET("/:id/versions", h.ListPipeVersions)
	pipes.GET("/:id/versions/:version", h.GetPipeVersion)
	pipes.POST("/:id/ops", h.AppendPipeOps)
	pipes.GET("/:id/ops", h.ListPipeOps)

	createBody := map[string]any{
		"name":        "pipe-a",
		"description": "d1",
		"nodes": []any{
			map[string]any{"id": "n1", "type": "sourceNode"},
		},
		"edges": []any{},
	}
	createBytes, _ := json.Marshal(createBody)
	createReq, _ := http.NewRequest("POST", "/api/pipes", bytes.NewBuffer(createBytes))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	r.ServeHTTP(createW, createReq)
	assert.Equal(t, http.StatusCreated, createW.Code)

	var created Pipe
	assert.NoError(t, json.Unmarshal(createW.Body.Bytes(), &created))
	assert.NotEmpty(t, created.ID)
	assert.Equal(t, "pipe-a", created.Name)
	assert.Equal(t, "d1", created.Description)
	assert.Equal(t, 1, created.Version)
	assert.False(t, created.CreatedAt.IsZero())
	assert.False(t, created.UpdatedAt.IsZero())

	updateBody := map[string]any{
		"name":        "pipe-a",
		"description": "d2",
		"nodes":       []any{},
		"edges":       []any{},
	}
	updateBytes, _ := json.Marshal(updateBody)
	updateReq, _ := http.NewRequest("PUT", "/api/pipes/"+created.ID, bytes.NewBuffer(updateBytes))
	updateReq.Header.Set("Content-Type", "application/json")
	updateW := httptest.NewRecorder()
	r.ServeHTTP(updateW, updateReq)
	assert.Equal(t, http.StatusOK, updateW.Code)

	var updated Pipe
	assert.NoError(t, json.Unmarshal(updateW.Body.Bytes(), &updated))
	assert.Equal(t, created.ID, updated.ID)
	assert.Equal(t, "d2", updated.Description)
	assert.Equal(t, 2, updated.Version)
	assert.Equal(t, created.CreatedAt, updated.CreatedAt)

	versionsReq, _ := http.NewRequest("GET", "/api/pipes/"+created.ID+"/versions", nil)
	versionsW := httptest.NewRecorder()
	r.ServeHTTP(versionsW, versionsReq)
	assert.Equal(t, http.StatusOK, versionsW.Code)

	var versions []PipeVersion
	assert.NoError(t, json.Unmarshal(versionsW.Body.Bytes(), &versions))
	assert.GreaterOrEqual(t, len(versions), 2)
	assert.Equal(t, 2, versions[0].Version)
	assert.Equal(t, 1, versions[len(versions)-1].Version)

	v1Req, _ := http.NewRequest("GET", "/api/pipes/"+created.ID+"/versions/1", nil)
	v1W := httptest.NewRecorder()
	r.ServeHTTP(v1W, v1Req)
	assert.Equal(t, http.StatusOK, v1W.Code)

	var v1 Pipe
	assert.NoError(t, json.Unmarshal(v1W.Body.Bytes(), &v1))
	assert.Equal(t, created.ID, v1.ID)
	assert.Equal(t, 1, v1.Version)
	assert.Equal(t, "d1", v1.Description)

	deleteReq, _ := http.NewRequest("DELETE", "/api/pipes/"+created.ID, nil)
	deleteW := httptest.NewRecorder()
	r.ServeHTTP(deleteW, deleteReq)
	assert.Equal(t, http.StatusOK, deleteW.Code)

	getAfterDeleteReq, _ := http.NewRequest("GET", "/api/pipes/"+created.ID, nil)
	getAfterDeleteW := httptest.NewRecorder()
	r.ServeHTTP(getAfterDeleteW, getAfterDeleteReq)
	assert.Equal(t, http.StatusNotFound, getAfterDeleteW.Code)
}

func TestPipeOpsAppendAndList(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-pipe-ops-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	r := gin.Default()
	apiGroup := r.Group("/api")
	pipes := apiGroup.Group("/pipes")
	pipes.POST("", h.SavePipe)
	pipes.GET("/:id", h.GetPipe)
	pipes.POST("/:id/ops", h.AppendPipeOps)
	pipes.GET("/:id/ops", h.ListPipeOps)

	createBody := map[string]any{
		"name":        "ops-pipe",
		"description": "",
		"nodes":       []any{},
		"edges":       []any{},
	}
	createBytes, _ := json.Marshal(createBody)
	createReq, _ := http.NewRequest("POST", "/api/pipes", bytes.NewBuffer(createBytes))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	r.ServeHTTP(createW, createReq)
	assert.Equal(t, http.StatusCreated, createW.Code)
	var created Pipe
	assert.NoError(t, json.Unmarshal(createW.Body.Bytes(), &created))

	append1 := []PipeOp{
		{TS: "2025-01-01T00:00:01Z", Kind: "node:add", Data: map[string]any{"id": "n1"}},
		{TS: "2025-01-01T00:00:02Z", Kind: "edge:add", Data: map[string]any{"id": "e1"}},
	}
	b1, _ := json.Marshal(append1)
	a1Req, _ := http.NewRequest("POST", "/api/pipes/"+created.ID+"/ops", bytes.NewBuffer(b1))
	a1Req.Header.Set("Content-Type", "application/json")
	a1W := httptest.NewRecorder()
	r.ServeHTTP(a1W, a1Req)
	assert.Equal(t, http.StatusOK, a1W.Code)

	time.Sleep(time.Nanosecond)

	append2 := []PipeOp{
		{TS: "2025-01-01T00:00:03Z", Kind: "node:update", Data: map[string]any{"id": "n1", "patch": map[string]any{"label": "x"}}},
	}
	b2, _ := json.Marshal(append2)
	a2Req, _ := http.NewRequest("POST", "/api/pipes/"+created.ID+"/ops", bytes.NewBuffer(b2))
	a2Req.Header.Set("Content-Type", "application/json")
	a2W := httptest.NewRecorder()
	r.ServeHTTP(a2W, a2Req)
	assert.Equal(t, http.StatusOK, a2W.Code)

	listReq, _ := http.NewRequest("GET", "/api/pipes/"+created.ID+"/ops?limit=10", nil)
	listW := httptest.NewRecorder()
	r.ServeHTTP(listW, listReq)
	assert.Equal(t, http.StatusOK, listW.Code)
	var ops []PipeOp
	assert.NoError(t, json.Unmarshal(listW.Body.Bytes(), &ops))
	assert.Len(t, ops, 3)
	assert.Equal(t, "node:update", ops[0].Kind)
	assert.Equal(t, "edge:add", ops[1].Kind)
	assert.Equal(t, "node:add", ops[2].Kind)
}

func TestPipeUpdate_AutoSaveDoesNotCreateVersion(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-pipe-autosave-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	r := gin.Default()
	apiGroup := r.Group("/api")
	pipes := apiGroup.Group("/pipes")
	pipes.POST("", h.SavePipe)
	pipes.PUT("/:id", h.UpdatePipe)
	pipes.GET("/:id/versions", h.ListPipeVersions)

	createBody := map[string]any{
		"name":        "autosave-pipe",
		"description": "d1",
		"nodes":       []any{},
		"edges":       []any{},
	}
	createBytes, _ := json.Marshal(createBody)
	createReq, _ := http.NewRequest("POST", "/api/pipes", bytes.NewBuffer(createBytes))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	r.ServeHTTP(createW, createReq)
	assert.Equal(t, http.StatusCreated, createW.Code)
	var created Pipe
	assert.NoError(t, json.Unmarshal(createW.Body.Bytes(), &created))
	assert.Equal(t, 1, created.Version)

	vReq1, _ := http.NewRequest("GET", "/api/pipes/"+created.ID+"/versions", nil)
	vW1 := httptest.NewRecorder()
	r.ServeHTTP(vW1, vReq1)
	assert.Equal(t, http.StatusOK, vW1.Code)
	var versions1 []PipeVersion
	assert.NoError(t, json.Unmarshal(vW1.Body.Bytes(), &versions1))
	assert.Len(t, versions1, 1)
	assert.Equal(t, 1, versions1[0].Version)

	autoBody := map[string]any{
		"name":        "autosave-pipe",
		"description": "d2",
		"nodes":       []any{},
		"edges":       []any{},
	}
	autoBytes, _ := json.Marshal(autoBody)
	autoReq, _ := http.NewRequest("PUT", "/api/pipes/"+created.ID+"?autosave=1", bytes.NewBuffer(autoBytes))
	autoReq.Header.Set("Content-Type", "application/json")
	autoW := httptest.NewRecorder()
	r.ServeHTTP(autoW, autoReq)
	assert.Equal(t, http.StatusOK, autoW.Code)
	var autoOut Pipe
	assert.NoError(t, json.Unmarshal(autoW.Body.Bytes(), &autoOut))
	assert.Equal(t, 1, autoOut.Version)
	assert.Equal(t, "d2", autoOut.Description)

	vReq2, _ := http.NewRequest("GET", "/api/pipes/"+created.ID+"/versions", nil)
	vW2 := httptest.NewRecorder()
	r.ServeHTTP(vW2, vReq2)
	assert.Equal(t, http.StatusOK, vW2.Code)
	var versions2 []PipeVersion
	assert.NoError(t, json.Unmarshal(vW2.Body.Bytes(), &versions2))
	assert.Len(t, versions2, 1)
	assert.Equal(t, 1, versions2[0].Version)

	normalBody := map[string]any{
		"name":        "autosave-pipe",
		"description": "d3",
		"nodes":       []any{},
		"edges":       []any{},
	}
	normalBytes, _ := json.Marshal(normalBody)
	normalReq, _ := http.NewRequest("PUT", "/api/pipes/"+created.ID, bytes.NewBuffer(normalBytes))
	normalReq.Header.Set("Content-Type", "application/json")
	normalW := httptest.NewRecorder()
	r.ServeHTTP(normalW, normalReq)
	assert.Equal(t, http.StatusOK, normalW.Code)
	var normalOut Pipe
	assert.NoError(t, json.Unmarshal(normalW.Body.Bytes(), &normalOut))
	assert.Equal(t, 2, normalOut.Version)

	vReq3, _ := http.NewRequest("GET", "/api/pipes/"+created.ID+"/versions", nil)
	vW3 := httptest.NewRecorder()
	r.ServeHTTP(vW3, vReq3)
	assert.Equal(t, http.StatusOK, vW3.Code)
	var versions3 []PipeVersion
	assert.NoError(t, json.Unmarshal(vW3.Body.Bytes(), &versions3))
	assert.Len(t, versions3, 2)
	assert.Equal(t, 2, versions3[0].Version)
	assert.Equal(t, 1, versions3[1].Version)
}

func TestPipeUpdate_ConflictDetectionAndForceOverwrite(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-pipe-conflict-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	r := gin.Default()
	apiGroup := r.Group("/api")
	pipes := apiGroup.Group("/pipes")
	pipes.POST("", h.SavePipe)
	pipes.PUT("/:id", h.UpdatePipe)
	pipes.GET("/:id", h.GetPipe)

	createBody := map[string]any{
		"name":        "conflict-pipe",
		"description": "d1",
		"nodes":       []any{},
		"edges":       []any{},
	}
	createBytes, _ := json.Marshal(createBody)
	createReq, _ := http.NewRequest("POST", "/api/pipes", bytes.NewBuffer(createBytes))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	r.ServeHTTP(createW, createReq)
	assert.Equal(t, http.StatusCreated, createW.Code)

	var created Pipe
	assert.NoError(t, json.Unmarshal(createW.Body.Bytes(), &created))
	assert.NotEmpty(t, created.UpdatedAt)
	baseUpdatedAt := created.UpdatedAt.Format(time.RFC3339Nano)

	autoBody1 := map[string]any{
		"name":        "conflict-pipe",
		"description": "d2",
		"nodes":       []any{},
		"edges":       []any{},
	}
	autoBytes1, _ := json.Marshal(autoBody1)
	autoReq1, _ := http.NewRequest("PUT", "/api/pipes/"+created.ID+"?autosave=1&base_updated_at="+url.QueryEscape(baseUpdatedAt), bytes.NewBuffer(autoBytes1))
	autoReq1.Header.Set("Content-Type", "application/json")
	autoW1 := httptest.NewRecorder()
	r.ServeHTTP(autoW1, autoReq1)
	assert.Equal(t, http.StatusOK, autoW1.Code)

	var autoOut1 Pipe
	assert.NoError(t, json.Unmarshal(autoW1.Body.Bytes(), &autoOut1))
	assert.Equal(t, created.Version, autoOut1.Version)
	currentUpdatedAt := autoOut1.UpdatedAt.Format(time.RFC3339Nano)
	assert.NotEqual(t, baseUpdatedAt, currentUpdatedAt)

	autoBody2 := map[string]any{
		"name":        "conflict-pipe",
		"description": "d3",
		"nodes":       []any{},
		"edges":       []any{},
	}
	autoBytes2, _ := json.Marshal(autoBody2)
	autoReq2, _ := http.NewRequest("PUT", "/api/pipes/"+created.ID+"?autosave=1&base_updated_at="+url.QueryEscape(baseUpdatedAt), bytes.NewBuffer(autoBytes2))
	autoReq2.Header.Set("Content-Type", "application/json")
	autoW2 := httptest.NewRecorder()
	r.ServeHTTP(autoW2, autoReq2)
	assert.Equal(t, http.StatusConflict, autoW2.Code)

	var conflict map[string]any
	assert.NoError(t, json.Unmarshal(autoW2.Body.Bytes(), &conflict))
	assert.Equal(t, float64(created.Version), conflict["current_version"])
	assert.Equal(t, currentUpdatedAt, conflict["current_updated_at"])

	autoReq3, _ := http.NewRequest("PUT", "/api/pipes/"+created.ID+"?autosave=1&force=1&base_updated_at="+url.QueryEscape(baseUpdatedAt), bytes.NewBuffer(autoBytes2))
	autoReq3.Header.Set("Content-Type", "application/json")
	autoW3 := httptest.NewRecorder()
	r.ServeHTTP(autoW3, autoReq3)
	assert.Equal(t, http.StatusOK, autoW3.Code)

	var autoOut3 Pipe
	assert.NoError(t, json.Unmarshal(autoW3.Body.Bytes(), &autoOut3))
	assert.Equal(t, created.Version, autoOut3.Version)
	assert.Equal(t, "d3", autoOut3.Description)
	assert.NotEqual(t, currentUpdatedAt, autoOut3.UpdatedAt.Format(time.RFC3339Nano))
}

func TestPipeUpdate_InvalidBaseUpdatedAt(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-pipe-invalid-base-updated-at-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	r := gin.Default()
	apiGroup := r.Group("/api")
	pipes := apiGroup.Group("/pipes")
	pipes.POST("", h.SavePipe)
	pipes.PUT("/:id", h.UpdatePipe)

	createBody := map[string]any{
		"name":        "invalid-base-updated-at-pipe",
		"description": "d1",
		"nodes":       []any{},
		"edges":       []any{},
	}
	createBytes, _ := json.Marshal(createBody)
	createReq, _ := http.NewRequest("POST", "/api/pipes", bytes.NewBuffer(createBytes))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	r.ServeHTTP(createW, createReq)
	assert.Equal(t, http.StatusCreated, createW.Code)

	var created Pipe
	assert.NoError(t, json.Unmarshal(createW.Body.Bytes(), &created))

	updateBody := map[string]any{
		"name":        created.Name,
		"description": "d2",
		"nodes":       []any{},
		"edges":       []any{},
	}
	updateBytes, _ := json.Marshal(updateBody)
	updateReq, _ := http.NewRequest("PUT", "/api/pipes/"+created.ID+"?autosave=1&base_updated_at=not-a-time", bytes.NewBuffer(updateBytes))
	updateReq.Header.Set("Content-Type", "application/json")
	updateW := httptest.NewRecorder()
	r.ServeHTTP(updateW, updateReq)
	assert.Equal(t, http.StatusBadRequest, updateW.Code)
}

func TestListPipesFilters(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-pipes-filter-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	r := gin.Default()
	apiGroup := r.Group("/api")
	pipes := apiGroup.Group("/pipes")
	pipes.POST("", h.SavePipe)
	pipes.GET("", h.ListPipes)

	create := func(name string) Pipe {
		body := map[string]any{
			"name":        name,
			"description": "",
			"nodes":       []any{},
			"edges":       []any{},
		}
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", "/api/pipes", bytes.NewBuffer(b))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		assert.Equal(t, http.StatusCreated, w.Code)
		var out Pipe
		assert.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		return out
	}

	p1 := create("alpha-pipe")
	_ = create("beta-pipe")

	qReq, _ := http.NewRequest("GET", "/api/pipes?name=alp", nil)
	qW := httptest.NewRecorder()
	r.ServeHTTP(qW, qReq)
	assert.Equal(t, http.StatusOK, qW.Code)
	var byName []Pipe
	assert.NoError(t, json.Unmarshal(qW.Body.Bytes(), &byName))
	assert.Len(t, byName, 1)
	assert.Equal(t, "alpha-pipe", byName[0].Name)

	idReq, _ := http.NewRequest("GET", "/api/pipes?id="+p1.ID, nil)
	idW := httptest.NewRecorder()
	r.ServeHTTP(idW, idReq)
	assert.Equal(t, http.StatusOK, idW.Code)
	var byID []Pipe
	assert.NoError(t, json.Unmarshal(idW.Body.Bytes(), &byID))
	assert.Len(t, byID, 1)
	assert.Equal(t, p1.ID, byID[0].ID)
}

func TestPipeConcurrentUpdates(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-pipes-concurrent-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	r := gin.Default()
	apiGroup := r.Group("/api")
	pipes := apiGroup.Group("/pipes")
	pipes.POST("", h.SavePipe)
	pipes.GET("/:id", h.GetPipe)
	pipes.PUT("/:id", h.UpdatePipe)

	createBody := map[string]any{
		"name":        "concurrent-pipe",
		"description": "init",
		"nodes":       []any{},
		"edges":       []any{},
	}
	createBytes, _ := json.Marshal(createBody)
	createReq, _ := http.NewRequest("POST", "/api/pipes", bytes.NewBuffer(createBytes))
	createReq.Header.Set("Content-Type", "application/json")
	createW := httptest.NewRecorder()
	r.ServeHTTP(createW, createReq)
	assert.Equal(t, http.StatusCreated, createW.Code)
	var created Pipe
	assert.NoError(t, json.Unmarshal(createW.Body.Bytes(), &created))

	const n = 20
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			updateBody := map[string]any{
				"name":        "concurrent-pipe",
				"description": fmt.Sprintf("d-%d", i),
				"nodes":       []any{},
				"edges":       []any{},
			}
			updateBytes, _ := json.Marshal(updateBody)
			updateReq, _ := http.NewRequest("PUT", "/api/pipes/"+created.ID, bytes.NewBuffer(updateBytes))
			updateReq.Header.Set("Content-Type", "application/json")
			updateW := httptest.NewRecorder()
			r.ServeHTTP(updateW, updateReq)
			assert.Equal(t, http.StatusOK, updateW.Code)
		}(i)
	}
	wg.Wait()

	getReq, _ := http.NewRequest("GET", "/api/pipes/"+created.ID, nil)
	getW := httptest.NewRecorder()
	r.ServeHTTP(getW, getReq)
	assert.Equal(t, http.StatusOK, getW.Code)
	var out Pipe
	assert.NoError(t, json.Unmarshal(getW.Body.Bytes(), &out))
	assert.Equal(t, 1+n, out.Version)
}

func TestRegistryQueryEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)

	registryServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, p, ok := r.BasicAuth()
		if !ok || u != "user" || p != "pass" {
			w.Header().Set("Www-Authenticate", `Basic realm="test"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/v2/_catalog":
			_ = json.NewEncoder(w).Encode(map[string]any{"repositories": []string{"ns/repo2", "ns/repo1"}})
		case r.URL.Path == "/v2/ns/repo1/tags/list":
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "ns/repo1", "tags": []string{"v2", "v1"}})
		default:
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": "not found"})
		}
	}))
	defer registryServer.Close()

	tempDir, err := os.MkdirTemp("", "horcrux-registry-query-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)
	assert.NoError(t, v.SaveCredentials([]vault.Credential{
		{ID: "cred1", Registry: registryServer.URL, Username: "user", Password: "pass"},
	}))

	h := NewHandler(v, NewHub())
	r := gin.Default()
	r.GET("/api/registry/repositories", h.ListRegistryRepositories)
	r.GET("/api/registry/tags", h.ListRegistryTags)

	w1 := httptest.NewRecorder()
	req1, _ := http.NewRequest(http.MethodGet, "/api/registry/repositories?cred_id=cred1", nil)
	r.ServeHTTP(w1, req1)
	assert.Equal(t, http.StatusOK, w1.Code)
	var reposResp map[string]any
	assert.NoError(t, json.Unmarshal(w1.Body.Bytes(), &reposResp))
	assert.Equal(t, []any{"ns/repo1", "ns/repo2"}, reposResp["repositories"])
	assert.Equal(t, false, reposResp["cached"])

	w2 := httptest.NewRecorder()
	req2, _ := http.NewRequest(http.MethodGet, "/api/registry/repositories?cred_id=cred1", nil)
	r.ServeHTTP(w2, req2)
	assert.Equal(t, http.StatusOK, w2.Code)
	var reposResp2 map[string]any
	assert.NoError(t, json.Unmarshal(w2.Body.Bytes(), &reposResp2))
	assert.Equal(t, true, reposResp2["cached"])

	w3 := httptest.NewRecorder()
	req3, _ := http.NewRequest(http.MethodGet, "/api/registry/tags?cred_id=cred1&repo=ns/repo1", nil)
	r.ServeHTTP(w3, req3)
	assert.Equal(t, http.StatusOK, w3.Code)
	var tagsResp map[string]any
	assert.NoError(t, json.Unmarshal(w3.Body.Bytes(), &tagsResp))
	assert.Equal(t, []any{"v1", "v2"}, tagsResp["tags"])
	assert.Equal(t, false, tagsResp["cached"])

	w4 := httptest.NewRecorder()
	req4, _ := http.NewRequest(http.MethodGet, "/api/registry/tags?cred_id=cred1&repo=ns/repo1", nil)
	r.ServeHTTP(w4, req4)
	assert.Equal(t, http.StatusOK, w4.Code)
	var tagsResp2 map[string]any
	assert.NoError(t, json.Unmarshal(w4.Body.Bytes(), &tagsResp2))
	assert.Equal(t, true, tagsResp2["cached"])
}

func TestGetStatsDataThroughput(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tempDir, err := os.MkdirTemp("", "horcrux-stats-test-*")
	assert.NoError(t, err)
	defer os.RemoveAll(tempDir)

	v, err := vault.NewVault(filepath.Join(tempDir, "vault.enc"), "12345678901234567890123456789012")
	assert.NoError(t, err)

	h := NewHandler(v, NewHub())

	// Write 1024 bytes -> 1.00 KB
	dummyFile := filepath.Join(tempDir, "dummy.dat")
	data := make([]byte, 1024)
	err = os.WriteFile(dummyFile, data, 0644)
	assert.NoError(t, err)

	r := gin.Default()
	r.GET("/api/stats", h.GetStats)

	req, _ := http.NewRequest("GET", "/api/stats", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	var response map[string]interface{}
	err = json.Unmarshal(w.Body.Bytes(), &response)
	assert.NoError(t, err)

	// Verify total_data_size
	val, ok := response["total_data_size"].(string)
	assert.True(t, ok)
	assert.Equal(t, "1.00 KB", val)
}
