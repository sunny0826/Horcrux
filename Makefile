# Horcrux Makefile

.PHONY: help build-frontend build-backend build-sidecar build clean dev-frontend dev-backend dev-web dev debug

ifeq ($(origin VITE_PORT), undefined)
VITE_PORT := $(shell sh -c 'p=7627; while lsof -iTCP:$$p -sTCP:LISTEN >/dev/null 2>&1; do p=$$((p+1)); done; echo $$p')
endif

help:
	@echo "Horcrux Management Commands:"
	@echo "  make dev            - Start Tauri app in development mode (Recommended)"
	@echo "  make dev-web        - Start web-only development mode"
	@echo "  make debug          - Start Tauri app in debug mode"
	@echo "  make build          - Build Tauri app for production"
	@echo "  make clean          - Remove build artifacts"
	@echo "  make install        - Install dependencies"

install:
	cd frontend && pnpm install
	cd backend && go mod download

# Web Components
build-frontend:
	cd frontend && pnpm build

build-backend:
	cd backend && go build -o ../horcrux main.go

build-sidecar:
	cd frontend && ./scripts/build_sidecar.sh

# Web Development
dev-frontend:
	cd frontend && pnpm dev -- --port $(VITE_PORT) --strictPort

dev-backend:
	cd backend && HORCRUX_DEV=1 HORCRUX_VITE_DEV_SERVER=http://localhost:$(VITE_PORT) PORT=7626 go run github.com/air-verse/air@latest -c .air.toml

dev-web:
	@echo "Starting WEB development environment on http://localhost:7626 ..."
	@make -j 2 dev-frontend dev-backend

# Tauri Commands
dev: build-sidecar
	@echo "Starting Tauri development environment..."
	cd frontend && pnpm tauri dev

debug: build-sidecar
	@echo "Starting Tauri in DEBUG mode..."
	cd frontend && RUST_LOG=debug pnpm tauri dev -- --debug

build: build-sidecar
	@echo "Building Tauri application..."
	cd frontend && pnpm tauri build

clean:
	rm -rf frontend/dist
	rm -f horcrux
	rm -f backend/horcrux
	rm -rf frontend/src-tauri/binaries
	rm -rf frontend/src-tauri/target

