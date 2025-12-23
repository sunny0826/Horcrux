package cli

import "testing"

func TestResolvePort_DefaultIs7626(t *testing.T) {
	t.Setenv("PORT", "")
	if got := resolvePort(); got != "7626" {
		t.Fatalf("expected default port 7626, got %s", got)
	}
}

func TestResolvePort_EnvOverrides(t *testing.T) {
	t.Setenv("PORT", "9999")
	if got := resolvePort(); got != "9999" {
		t.Fatalf("expected env port 9999, got %s", got)
	}
}

func TestIsDevMode(t *testing.T) {
	t.Setenv("HORCRUX_DEV", "")
	if isDevMode() {
		t.Fatalf("expected dev mode false when HORCRUX_DEV is empty")
	}
	t.Setenv("HORCRUX_DEV", "1")
	if !isDevMode() {
		t.Fatalf("expected dev mode true when HORCRUX_DEV is 1")
	}
}

func TestResolveViteDevServer_Default(t *testing.T) {
	t.Setenv("HORCRUX_VITE_DEV_SERVER", "")
	if got := resolveViteDevServer(); got != "http://localhost:7627" {
		t.Fatalf("expected default vite dev server http://localhost:7627, got %s", got)
	}
}
