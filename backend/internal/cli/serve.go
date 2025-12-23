package cli

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-contrib/static"
	"github.com/gin-gonic/gin"
	"github.com/guoxudong/horcrux/internal/api"
	"github.com/guoxudong/horcrux/internal/vault"
	"github.com/spf13/cobra"
)

var (
	serverPort    string
	serverDataDir string
)

var serveCmd = &cobra.Command{
	Use:   "serve",
	Short: "Start the Horcrux web server",
	Run: func(cmd *cobra.Command, args []string) {
		startServer()
	},
}

func init() {
	serveCmd.Flags().StringVar(&serverPort, "port", "", "Port to run the server on")
	serveCmd.Flags().StringVar(&serverDataDir, "data-dir", "", "Directory to store data")
	rootCmd.AddCommand(serveCmd)
}

func startServer() {
	key := os.Getenv("HORCRUX_SECRET")
	if key == "" {
		key = "12345678901234567890123456789012"
	}

	vaultPath := resolveVaultPath()
	v, err := vault.NewVault(vaultPath, key)
	if err != nil {
		log.Fatalf("Failed to initialize vault: %v", err)
	}

	hub := api.NewHub()
	go hub.Run()

	h := api.NewHandler(v, hub)

	r := gin.New()
	r.Use(gin.Logger())
	r.Use(gin.Recovery())
	r.RedirectTrailingSlash = false
	r.RedirectFixedPath = false

	if isDevMode() {
		viteProxy := createViteProxy()
		r.NoRoute(func(c *gin.Context) {
			if strings.HasPrefix(c.Request.URL.Path, "/api") {
				c.Status(http.StatusNotFound)
				return
			}
			viteProxy.ServeHTTP(c.Writer, c.Request)
		})
	} else {
		frontendDistDir := resolveFrontendDistDir()
		r.Use(static.Serve("/", static.LocalFile(frontendDistDir, true)))
		r.NoRoute(func(c *gin.Context) {
			if strings.HasPrefix(c.Request.URL.Path, "/api") {
				c.Status(http.StatusNotFound)
				return
			}

			indexPath := filepath.Join(frontendDistDir, "index.html")
			if _, err := os.Stat(indexPath); err != nil {
				c.String(http.StatusServiceUnavailable, "Frontend assets not built yet")
				return
			}
			c.File(indexPath)
		})
	}

	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS, PUT, DELETE")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	apiGroup := r.Group("/api")
	{
		apiGroup.GET("/health", h.Health)
		apiGroup.GET("/stats", h.GetStats)
		apiGroup.GET("/ws", h.HandleWS(hub))

		vaultGroup := apiGroup.Group("/vault")
		{
			vaultGroup.GET("/credentials", h.ListCredentials)
			vaultGroup.POST("/credentials", h.AddCredential)
			vaultGroup.PUT("/credentials/:id", h.UpdateCredential)
			vaultGroup.DELETE("/credentials/:id", h.DeleteCredential)
			vaultGroup.POST("/credentials/:id/verify", h.VerifyCredential)
		}

		tasksGroup := apiGroup.Group("/tasks")
		{
			tasksGroup.GET("", h.ListTasks)
			tasksGroup.GET("/:id", h.GetTask)
			tasksGroup.POST("/sync", h.ExecuteSync)
			tasksGroup.POST("/:id/retry", h.RetryTask)
			tasksGroup.POST("/:id/cancel", h.CancelTask)
		}

		pipesGroup := apiGroup.Group("/pipes")
		{
			pipesGroup.GET("", h.ListPipes)
			pipesGroup.POST("", h.SavePipe)
			pipesGroup.GET("/:id", h.GetPipe)
			pipesGroup.PUT("/:id", h.UpdatePipe)
			pipesGroup.DELETE("/:id", h.DeletePipe)
			pipesGroup.GET("/:id/versions", h.ListPipeVersions)
			pipesGroup.GET("/:id/versions/:version", h.GetPipeVersion)
			pipesGroup.POST("/:id/ops", h.AppendPipeOps)
			pipesGroup.GET("/:id/ops", h.ListPipeOps)
		}

		registryGroup := apiGroup.Group("/registry")
		{
			registryGroup.GET("/repositories", h.ListRegistryRepositories)
			registryGroup.GET("/tags", h.ListRegistryTags)
		}

		archivesGroup := apiGroup.Group("/archives")
		{
			archivesGroup.GET("", h.ListArchives)
			archivesGroup.POST("/upload", h.UploadArchive)
			archivesGroup.POST("/merge", h.MergeArchives)
			archivesGroup.DELETE("/:id", h.DeleteArchive)
		}
	}

	port := resolvePort()

	log.Printf("Horcrux backend starting on :%s", port)
	if err := r.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}

func resolvePort() string {
	if serverPort != "" {
		return serverPort
	}
	port := os.Getenv("PORT")
	if port == "" {
		return "7626"
	}
	return port
}

func isDevMode() bool {
	return os.Getenv("HORCRUX_DEV") == "1"
}

func resolveViteDevServer() string {
	s := os.Getenv("HORCRUX_VITE_DEV_SERVER")
	if s == "" {
		return "http://localhost:7627"
	}
	return s
}

func createViteProxy() *httputil.ReverseProxy {
	target, err := url.Parse(resolveViteDevServer())
	if err != nil {
		target = &url.URL{Scheme: "http", Host: "localhost:7627"}
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("Vite dev server is not available"))
	}
	return proxy
}

func resolveVaultPath() string {
	if serverDataDir != "" {
		// Ensure directory exists
		if _, err := os.Stat(serverDataDir); os.IsNotExist(err) {
			os.MkdirAll(serverDataDir, 0755)
		}
		return filepath.Join(serverDataDir, "vault.enc")
	}
	if _, err := os.Stat("data/vault.enc"); err == nil {
		return "data/vault.enc"
	}
	if _, err := os.Stat("backend/data/vault.enc"); err == nil {
		return "backend/data/vault.enc"
	}
	if _, err := os.Stat("../data/vault.enc"); err == nil {
		return "../data/vault.enc"
	}
	if _, err := os.Stat("../backend/data/vault.enc"); err == nil {
		return "../backend/data/vault.enc"
	}
	return "data/vault.enc"
}

func resolveFrontendDistDir() string {
	if _, err := os.Stat("../frontend"); err == nil {
		return "../frontend/dist"
	}
	return "frontend/dist"
}
