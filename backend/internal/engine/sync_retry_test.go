package engine

import (
	"context"
	"errors"
	"testing"
	"time"

	v1 "github.com/google/go-containerregistry/pkg/v1"
)

type timeoutNetError struct{}

func (timeoutNetError) Error() string   { return "i/o timeout" }
func (timeoutNetError) Timeout() bool   { return true }
func (timeoutNetError) Temporary() bool { return false }

func TestShouldRetryRemoteError_ContextCanceled(t *testing.T) {
	if shouldRetryRemoteError(context.Canceled) {
		t.Fatalf("expected context.Canceled not to be retried")
	}
}

func TestShouldRetryRemoteError_Unauthorized(t *testing.T) {
	if shouldRetryRemoteError(errors.New("unauthorized: bad credentials")) {
		t.Fatalf("expected unauthorized not to be retried")
	}
}

func TestShouldRetryRemoteError_NetTimeout(t *testing.T) {
	if !shouldRetryRemoteError(timeoutNetError{}) {
		t.Fatalf("expected timeout error to be retried")
	}
}

func TestShouldRetryRemoteError_HTTP2StreamInternalError(t *testing.T) {
	err := errors.New(`Patch "https://ghcr.io/v2/kwdb/smart-meter/blobs/upload/xxx": stream error: stream ID 9; INTERNAL_ERROR; received from peer`)
	if !shouldRetryRemoteError(err) {
		t.Fatalf("expected http2 stream internal error to be retried")
	}
}

func TestNewUploadProgressReporter_EmitsIncreasingPercent(t *testing.T) {
	progress := make(chan Progress, 8)
	s := NewSyncerWithContext(context.Background(), progress)

	updates, closeFn := s.newUploadProgressReporter("push_target", 0.75, 0.2)
	updates <- v1.Update{Total: 100, Complete: 1}
	updates <- v1.Update{Total: 100, Complete: 50}
	close(updates)
	closeFn()

	deadline := time.After(2 * time.Second)
	var got []Progress
	for len(got) < 2 {
		select {
		case p := <-progress:
			if p.Phase == "push_target" && p.Percent > 0 {
				got = append(got, p)
			}
		case <-deadline:
			t.Fatalf("timed out waiting for progress updates, got=%v", got)
		}
	}

	if got[0].Percent >= got[1].Percent {
		t.Fatalf("expected percent to increase, got=%v then %v", got[0].Percent, got[1].Percent)
	}
	if got[0].Percent < 0.75 || got[1].Percent > 0.95 {
		t.Fatalf("expected percent within [0.75,0.95], got=%v and %v", got[0].Percent, got[1].Percent)
	}
}

func TestFormatBytes(t *testing.T) {
	if got := formatBytes(0); got != "0B" {
		t.Fatalf("expected 0B, got=%s", got)
	}
	if got := formatBytes(1024); got != "1.00KB" {
		t.Fatalf("expected 1.00KB, got=%s", got)
	}
	if got := formatBytes(1024 * 1024); got != "1.00MB" {
		t.Fatalf("expected 1.00MB, got=%s", got)
	}
}
