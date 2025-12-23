# Horcrux Makefile

.PHONY: help build-frontend build-backend build clean dev-frontend dev-backend dev

ifeq ($(origin VITE_PORT), undefined)
VITE_PORT := $(shell sh -c 'p=7627; while lsof -iTCP:$$p -sTCP:LISTEN >/dev/null 2>&1; do p=$$((p+1)); done; echo $$p')
endif

help:
	@echo "Horcrux Management Commands:"
	@echo "  make dev            - Start both frontend and backend in development mode"
	@echo "  make build          - Build both frontend and backend for production"
	@echo "  make clean          - Remove build artifacts"
	@echo "  make build-frontend - Build only the frontend"
	@echo "  make build-backend  - Build only the backend"
	@echo "  make install        - Install dependencies for both frontend and backend"

install:
	cd frontend && pnpm install
	cd backend && go mod download

build-frontend:
	cd frontend && pnpm build

build-backend:
	cd backend && go build -o ../horcrux main.go

build: build-frontend build-backend
	@echo "Build complete. Binary: ./horcrux"

clean:
	rm -rf frontend/dist
	rm -f horcrux
	rm -f backend/horcrux

dev-frontend:
	cd frontend && pnpm dev -- --port $(VITE_PORT) --strictPort

dev-backend:
	cd backend && HORCRUX_DEV=1 HORCRUX_VITE_DEV_SERVER=http://localhost:$(VITE_PORT) PORT=7626 go run github.com/air-verse/air@latest -c .air.toml

dev:
	@echo "Starting development environment on http://localhost:7626 ..."
	@make -j 2 dev-frontend dev-backend
